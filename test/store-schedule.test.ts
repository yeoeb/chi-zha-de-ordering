import { env, exports } from "cloudflare:workers";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runScheduledStoreCycle } from "../src/worker/store-schedule";
import { performStoreOperation } from "../src/worker/store-operations";
import { orderTestSchedule } from "./order-acceptance-fixture";
const secret='local-schedule-audit-secret-at-least-32';
const closeTime='2026-10-06T23:15:00+08:00';
const openTime='2026-10-07T17:30:00+08:00';
const run=(now=closeTime,db=env.DB,scheduledTime?:number)=>runScheduledStoreCycle({db,now:new Date(now),scheduledTime,auditActorHashKey:secret,workerVersion:'local-test'});
async function state(){return env.DB.prepare('SELECT is_accepting_orders,state_version,pause_reason,scheduled_closed_business_date FROM store_settings WHERE id=1').first();}
async function orders(){return (await env.DB.prepare('SELECT * FROM orders').all()).results;}
beforeEach(async()=>{
 await env.DB.batch([
  env.DB.prepare('DELETE FROM store_state_events'),
  env.DB.prepare('DELETE FROM order_auto_rejection_events'),
  env.DB.prepare('DELETE FROM web_push_notification_deliveries'),
  env.DB.prepare('DELETE FROM order_item_modifiers'),
  env.DB.prepare('DELETE FROM order_items'),
  env.DB.prepare('DELETE FROM orders'),
  env.DB.prepare("UPDATE store_settings SET is_accepting_orders=1,state_version=0,missed_order_count=0,auto_pause_reason=NULL,pause_reason=NULL,scheduled_closed_business_date=NULL,weekly_business_hours=?,last_order_time='23:15' WHERE id=1").bind(JSON.stringify(orderTestSchedule)),
 ]);
});
async function order(status='accepted',created='2026-10-06T22:00:00+08:00',completed: string|null=null){
 await env.DB.prepare(`INSERT INTO orders(id,public_lookup_token,order_number,status,total_amount,estimated_ready_at,created_at,customer_name,customer_phone,special_order,idempotency_key,request_fingerprint,completed_at)
 VALUES('work',?,'work',?,0,'2026-10-06T22:30:00+08:00',?,'Local','Local',0,'work',?,?)`).bind('a'.repeat(64),status,created,'b'.repeat(64),completed).run();
}
function intercept(beforeBatch:()=>Promise<unknown>){return new Proxy(env.DB,{get(target,key){
 if(key==='batch')return async(s:D1PreparedStatement[])=>{await beforeBatch();return target.batch(s);};
 const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
}});}
const pause=()=>performStoreOperation({db:env.DB,action:'pause',request:{operationId:crypto.randomUUID(),expectedIsAcceptingOrders:true,expectedStateVersion:0},actorSubject:'human',auditActorHashKey:secret,now:new Date(closeTime)});
describe('daily safe store scheduling',()=>{
 it('closes once and opens next service day once with audit and version increments',async()=>{
  expect(await run()).toMatchObject({outcome:'APPLIED',action:'pause'});
  expect(await state()).toMatchObject({is_accepting_orders:0,state_version:1,pause_reason:'scheduled_closed',scheduled_closed_business_date:'2026-10-06'});
  expect(await run()).toMatchObject({outcome:'SKIPPED'});
  expect(await run(openTime)).toMatchObject({outcome:'APPLIED',action:'resume'});
  expect(await run(openTime)).toMatchObject({outcome:'SKIPPED'});
  expect(await state()).toMatchObject({is_accepting_orders:1,state_version:2,pause_reason:null});
  expect((await env.DB.prepare('SELECT action,from_state_version,to_state_version FROM store_state_events ORDER BY created_at').all()).results).toEqual([{action:'pause',from_state_version:0,to_state_version:1},{action:'resume',from_state_version:1,to_state_version:2}]);
 });
 it('does not close before 23:15',async()=>{expect(await run('2026-10-06T23:14:59+08:00')).toMatchObject({outcome:'SKIPPED'});expect(await state()).toMatchObject({state_version:0});});
 it.each(['pending','accepted'])('never infers completion of %s from estimated-ready time',async status=>{
  await order(status);const before=await orders();expect(await run()).toMatchObject({outcome:'SKIPPED'});expect(await orders()).toEqual(before);
 });
 it('requires actual completion evidence and five quiet minutes',async()=>{
  await order('completed','2026-10-06T23:11:00+08:00','2026-10-06T23:14:00+08:00');
  expect(await run()).toMatchObject({outcome:'SKIPPED'});
  expect(await run('2026-10-06T23:16:00+08:00')).toMatchObject({outcome:'APPLIED'});
 });
 it('completed without a completion timestamp does not prove work is done',async()=>{await order('completed');expect(await run()).toMatchObject({outcome:'SKIPPED'});});
 it('closes after midnight under the previous service date',async()=>{
  expect(await run('2026-10-07T00:30:00+08:00')).toMatchObject({outcome:'APPLIED'});
  expect(await state()).toMatchObject({scheduled_closed_business_date:'2026-10-06'});
 });
 it.each([null,'manual_pause','missed_orders','unknown'])('never resumes paused reason %s',async reason=>{
  await env.DB.prepare('UPDATE store_settings SET is_accepting_orders=0,pause_reason=? WHERE id=1').bind(reason).run();
  const before=await state();expect(await run(openTime)).toMatchObject({outcome:'SKIPPED'});expect(await state()).toEqual(before);
 });
 it('rejects fabricated scheduled_closed state without a matching closure audit',async()=>{
  await env.DB.prepare("UPDATE store_settings SET is_accepting_orders=0,pause_reason='scheduled_closed',scheduled_closed_business_date='2026-10-06' WHERE id=1").run();
  expect(await run(openTime)).toMatchObject({outcome:'SKIPPED'});
 });
 it('does not resume on closed weekdays, before opening, or after the next earliest-close time',async()=>{
  await run();for(const t of ['2026-10-07T17:29:59+08:00','2026-10-12T18:00:00+08:00','2026-10-07T23:16:00+08:00'])expect(await run(t)).toMatchObject({outcome:'SKIPPED'});
 });
 it('handles delayed opening and duplicate delivery without replaying yesterday into today',async()=>{
  await run();expect(await run('2026-10-07T18:00:00+08:00',env.DB,new Date(openTime).getTime())).toMatchObject({outcome:'APPLIED'});
  expect(await run('2026-10-08T18:00:00+08:00',env.DB,new Date(openTime).getTime())).toMatchObject({outcome:'SKIPPED'});
 });
 it('a late close delivered across an opening boundary cannot close the new service day',async()=>{
  expect(await run(openTime,env.DB,new Date(closeTime).getTime())).toMatchObject({outcome:'SKIPPED'});expect(await state()).toMatchObject({state_version:0});
 });
 it('allows one concurrent close and one concurrent resume',async()=>{
  expect((await Promise.all([run(),run()])).filter(r=>r.outcome==='APPLIED')).toHaveLength(1);
  expect((await Promise.all([run(openTime),run(openTime)])).filter(r=>r.outcome==='APPLIED')).toHaveLength(1);
  expect(await state()).toMatchObject({state_version:2});
 });
 it('manual pause wins against a closing snapshot via CAS',async()=>{
  expect(await run(closeTime,intercept(pause))).toMatchObject({outcome:'SKIPPED'});
  expect(await state()).toMatchObject({is_accepting_orders:0,pause_reason:'manual_pause',state_version:1});expect(await run(openTime)).toMatchObject({outcome:'SKIPPED'});
 });
 it('manual Pause while already scheduled closed blocks automatic resume even after a busy-mode version change',async()=>{
  await run();await pause();await env.DB.prepare('UPDATE store_settings SET state_version=state_version+1 WHERE id=1').run();
  expect(await run(openTime)).toMatchObject({outcome:'SKIPPED'});
 });
 it('an order arriving inside the atomic-close boundary prevents close',async()=>{
  expect(await run(closeTime,intercept(()=>order('pending')))).toMatchObject({outcome:'SKIPPED'});
  expect(await state()).toMatchObject({is_accepting_orders:1,state_version:0});
 });
 it('a concurrent reason or schedule change invalidates the close snapshot',async()=>{
  const db=intercept(()=>env.DB.prepare("UPDATE store_settings SET pause_reason='unknown' WHERE id=1").run());
  expect(await run(closeTime,db)).toMatchObject({outcome:'SKIPPED'});
 });
 it('audit failure rolls back closure and permits retry',async()=>{
  await env.DB.prepare("CREATE TRIGGER fail_schedule_audit BEFORE INSERT ON store_state_events BEGIN SELECT RAISE(ABORT,'local failure'); END").run();
  await expect(run()).rejects.toThrow();expect(await state()).toMatchObject({is_accepting_orders:1,state_version:0});
  await env.DB.prepare('DROP TRIGGER fail_schedule_audit').run();expect(await run()).toMatchObject({outcome:'APPLIED'});
 });
 it('scheduled handler keeps the existing maintenance and executes the new cycle',async()=>{
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date(closeTime));
  try {
   const worker=(await import('../src/worker/index')).default;const tasks:Promise<unknown>[]=[];
   worker.scheduled({scheduledTime:new Date(closeTime).getTime(),cron:'* * * * *'} as ScheduledController,env,{waitUntil:(task:Promise<unknown>)=>tasks.push(task)} as unknown as ExecutionContext);
   await Promise.all(tasks);expect(await state()).toMatchObject({pause_reason:'scheduled_closed',state_version:1});
  } finally {vi.useRealTimers();}
 });
 it('a quote or new order after scheduled closure is rejected without children',async()=>{
  await run();const before=await orders();
  const response=await exports.default.fetch('https://example.com/api/checkout/quote',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({items:[{menuItemId:990,modifierOptionIds:[],quantity:1}]})});
  expect(response.status).toBe(409);expect(await orders()).toEqual(before);
 });
 it('manual Pause racing with next-day resume prevents reopening',async()=>{
  await run();expect(await run(openTime,intercept(pause))).toMatchObject({outcome:'SKIPPED'});expect(await state()).toMatchObject({is_accepting_orders:0});
 });
 it('schedule changes inside CAS and version exhaustion remain closed',async()=>{
  await run();const db=intercept(()=>env.DB.prepare("UPDATE store_settings SET weekly_business_hours='{}' WHERE id=1").run());
  expect(await run(openTime,db)).toMatchObject({outcome:'SKIPPED'});
  await env.DB.prepare('UPDATE store_settings SET weekly_business_hours=?,state_version=? WHERE id=1').bind(JSON.stringify(orderTestSchedule),Number.MAX_SAFE_INTEGER).run();
  expect(await run(openTime)).toMatchObject({outcome:'SKIPPED'});
 });
 it('new order commit losing the close race leaves zero order children',async()=>{
  await env.DB.prepare("INSERT INTO menu_categories(id,name,sort_order,is_active) VALUES(991,'Race',1,1)").run();
  await env.DB.prepare("INSERT INTO menu_items(id,category_id,name,description,price,sort_order,is_available) VALUES(991,991,'Race','',81,1,1)").run();
  const {createOrder}=await import('../src/worker/order-creation');const {validateAndPriceCart,createQuoteFingerprint}=await import('../src/worker/checkout-quote');
  const items=[{menuItemId:991,modifierOptionIds:[],quantity:1}];const quoteFingerprint=await createQuoteFingerprint(await validateAndPriceCart(env.DB,items));
  const db=new Proxy(env.DB,{get(target,key){if(key==='batch')return async(statements:D1PreparedStatement[])=>{await run();return target.batch(statements);};const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;}});
  await expect(createOrder(db,{items,specialOrder:false,quoteFingerprint,customerName:'Local',customerPhone:'Local'},'close-race',new Date(closeTime))).rejects.toMatchObject({code:'STORE_NOT_ACCEPTING_ORDERS'});
  expect(await orders()).toEqual([]);expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM order_items').first())!.n).toBe(0);
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM web_push_notification_deliveries').first())!.n).toBe(0);
 });
 it('missing audit key cannot mutate Store',async()=>{
  await expect(runScheduledStoreCycle({db:env.DB,now:new Date(closeTime)})).rejects.toThrow();expect(await state()).toMatchObject({state_version:0});
 });
 it('fails closed on exhausted version, corrupted schedule and missed-order safety state',async()=>{
  await env.DB.prepare('UPDATE store_settings SET missed_order_count=1 WHERE id=1').run();expect(await run()).toMatchObject({outcome:'SKIPPED'});
  await env.DB.prepare("UPDATE store_settings SET missed_order_count=0,weekly_business_hours='{}' WHERE id=1").run();expect(await run()).toMatchObject({outcome:'SKIPPED'});
 });
});
