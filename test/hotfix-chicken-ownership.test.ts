import { env, exports } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { setupOrderAcceptanceTests } from "./order-acceptance-fixture";
setupOrderAcceptanceTests();
beforeAll(async () => {
 await env.DB.batch([
  env.DB.prepare("INSERT INTO menu_categories(id,name,sort_order,is_active) VALUES(4,'雞排類',40,1)"),
  env.DB.prepare("INSERT INTO menu_items(id,category_id,name,description,price,sort_order,is_available) VALUES(1,4,'傳統雞排','',90,10,1),(48,4,'起司雞排','不能切',100,20,1),(49,4,'香蔥雞排','不能切',100,30,1),(53,4,'泡菜雞排','不能切',100,40,1),(50,4,'泡菜起司雞排','不能切',110,50,1)"),
  env.DB.prepare("INSERT INTO modifier_groups(id,menu_item_id,name,selection_type,is_required,sort_order,is_active) VALUES(1,1,'辣度','single',1,10,1),(2,1,'切法','single',1,20,1),(48,48,'辣度','single',1,10,1),(49,49,'辣度','single',1,10,1),(50,50,'辣度','single',1,10,1),(53,53,'辣度','single',1,10,1)"),
  env.DB.prepare("INSERT INTO modifier_options(id,modifier_group_id,name,price_delta,sort_order,is_active) VALUES(1,1,'不辣',0,10,1),(5,2,'不切',0,10,1),(6,2,'切',0,20,1),(48,48,'微辣',0,15,1),(49,49,'微辣',0,15,1),(50,50,'微辣',0,15,1),(53,53,'微辣',0,15,1)")
 ]);
});
async function quote(id: number, options: number[]) {
 return exports.default.fetch("https://example.com/api/checkout/quote", {method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({items:[{menuItemId:id,quantity:1,modifierOptionIds:options}]})});
}
describe("hotfix chicken ownership and authoritative prices", () => {
 it.each([[48,100],[49,100],[50,110],[53,100]])("variant %i accepts its own spice and cannot submit traditional cutting", async (id,price) => {
  const good=await quote(id,[id]);expect(good.status).toBe(200);
  expect(await good.json()).toMatchObject({total:price,items:[{menuItemId:id,unitPrice:price,modifiers:[{name:"微辣"}]}]});
  for(const cut of [5,6]){const bad=await quote(id,[id,cut]);expect(bad.status).toBe(422);expect(await bad.json()).toMatchObject({error:{code:"INVALID_MODIFIER_OPTION"}});}
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM orders").first()).toEqual({n:0});
 });
 it.each([5,6])("traditional chicken alone accepts cutting option %i",async cut=>{
  const response=await quote(1,[1,cut]);expect(response.status).toBe(200);expect(await response.json()).toMatchObject({total:90});
 });
});
