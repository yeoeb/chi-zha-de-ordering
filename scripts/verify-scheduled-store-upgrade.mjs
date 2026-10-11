import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const sql=p=>readFileSync(resolve(root,p),'utf8');
const migrations=readdirSync(resolve(root,'migrations')).filter(p=>/^\d{4}.*\.sql$/.test(p)).sort();
function migrate(db,limit){for(const p of migrations.filter(p=>Number(p.slice(0,4))<=limit)) db.exec(sql('migrations/'+p));}
function rows(db,table){return db.prepare('SELECT * FROM '+table+' ORDER BY rowid').all().map(r=>({...r}));}
for(const scenario of ['fresh','upgrade']){
 const db=new DatabaseSync(':memory:');
 migrate(db,scenario==='fresh'?21:20);
 db.exec(`INSERT INTO menu_categories(id,name,sort_order,is_active) VALUES(1,'Local',1,1);
 INSERT INTO menu_items(id,category_id,name,description,price,sort_order,is_available) VALUES(4,1,'鹽酥雞','',83,1,1),(3,1,'香酥魷魚','',117,2,1);
 INSERT INTO modifier_groups(id,menu_item_id,name,selection_type,is_required,sort_order,is_active) VALUES(7,4,'份量','single',1,1,1),(8,3,'份量','single',1,1,1);
 INSERT INTO modifier_options(id,modifier_group_id,name,price_delta,sort_order,is_active) VALUES(28,7,'大份',40,1,1),(30,8,'大份',40,1,1);
 UPDATE store_settings SET is_accepting_orders=0,state_version=7,auto_pause_reason=NULL;`);
 const before={menu:rows(db,'menu_items'),store:rows(db,'store_settings'),options:rows(db,'modifier_options'),orders:rows(db,'orders')};
 if(scenario==='upgrade')db.exec(sql('migrations/0021_add_scheduled_store_closure.sql'));
 const store=rows(db,'store_settings')[0];assert.equal(store.pause_reason,null);assert.equal(store.scheduled_closed_business_date,null);
 const legacyStore={...store};delete legacyStore.pause_reason;delete legacyStore.scheduled_closed_business_date;
 const expected={...before.store[0]};delete expected.pause_reason;delete expected.scheduled_closed_business_date;assert.deepEqual(legacyStore,expected);
 db.exec(sql('production-data/set-large-portion-delta-35.sql'));assert.equal(db.prepare('SELECT changes() n').get().n,2);
 db.exec(sql('production-data/set-large-portion-delta-35.sql'));assert.equal(db.prepare('SELECT changes() n').get().n,0);
 assert.deepEqual(rows(db,'menu_items'),before.menu);assert.deepEqual(rows(db,'orders'),before.orders);
 assert.deepEqual(rows(db,'modifier_options'),before.options.map(r=>({...r,price_delta:35})));
 db.exec("UPDATE modifier_options SET name='wrong',price_delta=90 WHERE id=30; UPDATE modifier_options SET price_delta=80 WHERE id=28;");
 const mismatch=rows(db,'modifier_options');db.exec(sql('production-data/set-large-portion-delta-35.sql'));assert.deepEqual(rows(db,'modifier_options'),mismatch);
 assert.equal(Object.values(db.prepare('PRAGMA quick_check').get())[0],'ok');
 assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
 db.close();console.log(scenario+': PASS (additive migration, no inferred closure, prices preserved, bounded/idempotent patch, quick_check=ok)');
}
