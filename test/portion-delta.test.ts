/// <reference types="vite/client" />
import { env, exports } from "cloudflare:workers";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import patch from "../production-data/set-large-portion-delta-35.sql?raw";
import { setupOrderAcceptanceTests } from "./order-acceptance-fixture";
import { createCartLine, getCartTotal, toCheckoutItems } from "../src/react-app/cart";
setupOrderAcceptanceTests();
beforeAll(async()=>{
 await env.DB.batch([
  env.DB.prepare("INSERT INTO menu_categories(id,name,sort_order,is_active) VALUES(3,'測試',1,1)"),
  env.DB.prepare("INSERT INTO menu_items(id,category_id,name,description,price,sort_order,is_available) VALUES(4,3,'鹽酥雞','',73,1,1),(3,3,'香酥魷魚','',91,2,1),(999,3,'其他商品','',147,3,1)"),
  env.DB.prepare("INSERT INTO modifier_groups(id,menu_item_id,name,selection_type,is_required,sort_order,is_active) VALUES(7,4,'份量','single',1,1,1),(8,3,'份量','single',1,1,1),(999,999,'份量','single',1,1,1)"),
  env.DB.prepare("INSERT INTO modifier_options(id,modifier_group_id,name,price_delta,sort_order,is_active) VALUES(27,7,'小份',0,1,1),(28,7,'大份',40,2,1),(29,8,'小份',0,1,1),(30,8,'大份',40,2,1),(999,999,'大份',88,1,1)"),
 ]);
});
beforeEach(async()=>{
 await env.DB.batch([env.DB.prepare('DELETE FROM web_push_notification_deliveries'),env.DB.prepare('DELETE FROM order_item_modifiers'),env.DB.prepare('DELETE FROM order_items'),env.DB.prepare('DELETE FROM orders')]);
 await env.DB.prepare("UPDATE store_settings SET is_accepting_orders=1 WHERE id=1").run();
 await env.DB.prepare("UPDATE modifier_options SET price_delta=40,name='大份' WHERE id IN(28,30)").run();
});
const prices=async()=>(await env.DB.prepare("SELECT id,price FROM menu_items ORDER BY id").all()).results;
const options=async()=>(await env.DB.prepare("SELECT * FROM modifier_options ORDER BY id").all()).results;
async function quote(items: unknown){
 const response=await exports.default.fetch('https://example.com/api/checkout/quote',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({items})});
 expect(response.status).toBe(200);
 return response.json() as Promise<{total:number;quoteFingerprint:string}>;
}
describe('bounded +35 modifier patch',()=>{
 it('updates exactly two deltas, is idempotent and preserves every base price',async()=>{
  const before=await prices();
  expect((await env.DB.prepare(patch).run()).meta.changes).toBe(2);
  expect((await env.DB.prepare(patch).run()).meta.changes).toBe(0);
  expect(await prices()).toEqual(before);
  expect((await options()).map(r=>[r.id,r.price_delta])).toEqual([[27,0],[28,35],[29,0],[30,35],[999,88]]);
 });
 it('fails the entire patch closed when either identity differs',async()=>{
  await env.DB.prepare("UPDATE modifier_options SET name='其他大份' WHERE id=30").run();
  const before=await options();
  expect((await env.DB.prepare(patch).run()).meta.changes).toBe(0);
  expect(await options()).toEqual(before);
 });
 for(const [itemId,optionId,groupId,basePrice] of [[4,28,7,73],[3,30,8,91]]){
  for(const source of ['online','onsite']){
   it(source+' item '+itemId+' uses current base +35 through Cart, Quote and order snapshots',async()=>{
    await env.DB.prepare(patch).run();
    const line={...createCartLine({id:itemId!,name:'測試',price:basePrice!},[{groupId:groupId!,groupName:'份量',optionId:optionId!,optionName:'大份',priceDelta:35}]),quantity:2};
    const items=toCheckoutItems([line]); const q=await quote(items);
    expect(getCartTotal([line])).toBe((basePrice!+35)*2);expect(q.total).toBe(getCartTotal([line]));
    const response=await exports.default.fetch('https://example.com/api/'+(source==='online'?'orders':'onsite/orders'),{
     method:'POST',headers:{'Content-Type':'application/json',Origin:'https://example.com','Sec-Fetch-Site':'same-origin','Idempotency-Key':source+itemId},
     body:JSON.stringify({items,specialOrder:false,quoteFingerprint:q.quoteFingerprint}),
    });
    expect(response.status).toBe(201);
    const before=(await env.DB.prepare('SELECT * FROM order_items').all()).results;
    const modifiers=(await env.DB.prepare('SELECT * FROM order_item_modifiers').all()).results;
    await env.DB.prepare('UPDATE modifier_options SET price_delta=35 WHERE id IN(28,30)').run();
    await env.DB.prepare(patch).run();
    expect((await env.DB.prepare('SELECT * FROM order_items').all()).results).toEqual(before);
    expect((await env.DB.prepare('SELECT * FROM order_item_modifiers').all()).results).toEqual(modifiers);
    expect(before).toEqual([expect.objectContaining({unit_price:basePrice!+35,line_total:q.total})]);
   });
  }
 }
 it('preserves pre-patch historical snapshots with +40',async()=>{
  const items=[{menuItemId:4,modifierOptionIds:[28],quantity:1}];const q=await quote(items);
  const r=await exports.default.fetch('https://example.com/api/orders',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://example.com','Sec-Fetch-Site':'same-origin','Idempotency-Key':'history'},body:JSON.stringify({items,specialOrder:false,quoteFingerprint:q.quoteFingerprint})});expect(r.status).toBe(201);
  const before=(await env.DB.prepare('SELECT * FROM order_items').all()).results;const mods=(await env.DB.prepare('SELECT * FROM order_item_modifiers').all()).results;
  await env.DB.prepare(patch).run();expect((await quote(items)).total).toBe(108);
  expect((await env.DB.prepare('SELECT * FROM order_items').all()).results).toEqual(before);expect((await env.DB.prepare('SELECT * FROM order_item_modifiers').all()).results).toEqual(mods);
  expect(mods[0]).toMatchObject({price_delta:40});
 });
});
