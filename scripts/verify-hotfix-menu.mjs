import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { unstable_splitSqlQuery as splitSql } from "wrangler";
const root = fileURLToPath(new URL("../", import.meta.url));
const before = JSON.parse(readFileSync(`${root}/scripts/fixtures/hotfix-menu-before.json`, "utf8"));
const tables = {categories:"menu_categories",items:"menu_items",groups:"modifier_groups",options:"modifier_options"};
const sql = readFileSync(`${root}/production-data/apply-owner-approved-menu-hotfix.sql`, "utf8");
assert(!/\b(?:DELETE|DROP|ALTER|REPLACE)\b/i.test(sql));
assert(!/\b(?:UPDATE|INSERT INTO)\s+(?:orders|order_items|order_item_modifiers|store_settings)\b/i.test(sql));
assert(!/SET[^;]*(?:is_available|sold_out_business_date)\s*=/i.test(sql));
const mf = new Miniflare(convertV4MiniflareOptions({modules:true,script:"",compatibilityDate:"2026-08-18",d1Databases:{DB:"hotfix-verifier"}}));
try {
 const db = await mf.getD1Database("DB");
 const batch = async text => db.batch(splitSql(text).map(s=>db.prepare(s)));
 for(const file of readdirSync(`${root}/migrations`).filter(n=>/^\d{4}_.*\.sql$/.test(n)).sort()) await batch(readFileSync(`${root}/migrations/${file}`,"utf8"));
 for(const [key,table] of Object.entries(tables)) for(const row of before[key]) await db.prepare(`INSERT INTO ${table} (${Object.keys(row)}) VALUES (${Object.keys(row).map(()=>"?")})`).bind(...Object.values(row)).run();
 await batch(`INSERT INTO orders (id,order_number,status,total_amount,estimated_ready_at,created_at,customer_name,customer_phone,special_order,idempotency_key,request_fingerprint,public_lookup_token) VALUES ('history','LOCAL-HISTORY','completed',70,'2026-10-08T10:00:00Z','2026-10-08T09:00:00Z','test','test',0,'history-key','${"a".repeat(64)}','${"b".repeat(64)}'); INSERT INTO order_items (id,order_id,menu_item_id,item_name,unit_price,quantity,line_total,sort_order) VALUES ('line','history',1,'香雞排',70,1,70,0); INSERT INTO order_item_modifiers (id,order_item_id,modifier_group_name,modifier_option_id,modifier_option_name,price_delta,sort_order) VALUES ('modifier','line','辣度',1,'不辣',0,0);`);
 const read = async table => (await db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()).results;
 const history = async () => Promise.all(["orders","order_items","order_item_modifiers","store_settings"].map(read));
 const snapshots = await history();
 await assert.rejects(db.batch([db.prepare("UPDATE menu_items SET price=price+1 WHERE id=1"),db.prepare(splitSql(sql)[0])]));
 assert.equal((await db.prepare("SELECT price FROM menu_items WHERE id=1").first()).price,before.items.find(i=>i.id===1).price);
 await batch("UPDATE menu_items SET price=price+1 WHERE id=1");
 await assert.rejects(batch(sql));
 assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM menu_categories").first()).n,3);
 assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM modifier_options").first()).n,24);
 await batch("UPDATE menu_items SET price=price-1 WHERE id=1");
 await batch(sql);
 const result = await Promise.all(Object.values(tables).map(read));
 await batch(sql); assert.deepEqual(await Promise.all(Object.values(tables).map(read)),result);
 assert.deepEqual(await history(),snapshots);
 const active = result[1].filter(i=>!i.is_archived);
 assert.equal(active.length,47);
 const levels=["不辣","微辣","小辣","中辣","大辣"];
 for(const item of active) {
  const groups=result[2].filter(g=>g.menu_item_id===item.id&&g.is_active);
  const spice=groups.filter(g=>g.name==="辣度");
  if(item.id===5){assert.equal(spice.length,0);continue;}
  assert.equal(spice.length,1);assert.equal(spice[0].is_required,1);
  for(const name of levels) assert.equal(result[3].filter(o=>o.modifier_group_id===spice[0].id&&o.is_active&&o.name===name).length,1);
  if([9,10].includes(item.id))assert(groups.find(g=>g.name==="調味").sort_order<spice[0].sort_order);
 }
 for(const id of [1,48,49,50,53])assert(active.some(i=>i.id===id&&i.category_id===4));
 assert.equal(active.find(i=>i.id===53).price,100);
 assert.deepEqual(result[2].filter(g=>g.name==="切法"&&g.is_active).map(g=>g.menu_item_id),[1]);
 for(const prev of before.items){const next=result[1].find(i=>i.id===prev.id);assert.equal(next.is_available,prev.is_available);assert.equal(next.sold_out_business_date,prev.sold_out_business_date);}
 assert.equal((await db.prepare("PRAGMA quick_check").first()).quick_check,"ok");
 console.log("Hotfix menu PASS: exact drift guard, atomic failed-batch rollback, repeat-safe bounded sync, 47 active products, 46 complete spice groups, five required chicken variants, seasoning before spice, traditional-only cutting, unchanged full historical rows/Store/availability and quick_check.");
} finally {await mf.dispose();}
