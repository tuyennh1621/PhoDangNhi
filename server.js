import 'dotenv/config';
import express from 'express';
import { MongoClient, ServerApiVersion } from 'mongodb';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const uri = process.env.MONGODB_URI;
if (!uri) throw new Error('MONGODB_URI is missing. Copy .env.example to .env and set your MongoDB URI.');

const client = new MongoClient(uri, {
  serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true }
});
let db;

const DEFAULT_MENU = [
  { id:1,name:'Phở tái',price:35000,cat:'Phở',active:true },
  { id:2,name:'Phở chín',price:35000,cat:'Phở',active:true },
  { id:3,name:'Phở bắp',price:40000,cat:'Phở',active:true },
  { id:4,name:'Phở nạm',price:40000,cat:'Phở',active:true },
  { id:5,name:'Phở gầu',price:40000,cat:'Phở',active:true },
  { id:6,name:'Phở tái nạm',price:40000,cat:'Phở',active:true },
  { id:7,name:'Phở tái gầu',price:40000,cat:'Phở',active:true },
  { id:8,name:'Phở tái chín',price:40000,cat:'Phở',active:true }
];

const DEFAULT_INVENTORY = [
  { id:1,name:'Thịt bò',unit:'kg',stock:0,minStock:5 },
  { id:2,name:'Xương bò',unit:'kg',stock:0,minStock:5 },
  { id:3,name:'Bánh phở',unit:'kg',stock:0,minStock:5 },
  { id:4,name:'Hành lá',unit:'kg',stock:0,minStock:1 },
  { id:5,name:'Giá đỗ',unit:'kg',stock:0,minStock:1 }
];

const DEFAULT_EXPENSE_TYPES = [
  { id:1,name:'Mặt bằng',amount:4000000 },
  { id:2,name:'Điện',amount:3000000 },
  { id:3,name:'Nước',amount:1000000 },
  { id:4,name:'Nhân viên',amount:6000000 }
];

async function connect(){
  await client.connect();
  await client.db('admin').command({ ping: 1 });
  db = client.db(process.env.MONGODB_DB || 'pho_dang_nhi');
  await db.collection('menu').createIndex({ id: 1 }, { unique: true });
  await db.collection('tables').createIndex({ id: 1 }, { unique: true });
  await db.collection('orders').createIndex({ id: 1 }, { unique: true });
  await db.collection('invoices').createIndex({ id: 1 }, { unique: true });
  await db.collection('inventory').createIndex({ id: 1 }, { unique: true });
  await db.collection('stockins').createIndex({ id: 1 }, { unique: true });
  await db.collection('expensetypes').createIndex({ id: 1 }, { unique: true });
  await db.collection('expenses').createIndex({ id: 1 }, { unique: true });
  if (!(await db.collection('menu').countDocuments())) await db.collection('menu').insertMany(DEFAULT_MENU);
  if (!(await db.collection('inventory').countDocuments())) await db.collection('inventory').insertMany(DEFAULT_INVENTORY);
  if (!(await db.collection('expensetypes').countDocuments())) await db.collection('expensetypes').insertMany(DEFAULT_EXPENSE_TYPES);
  if (!(await db.collection('settings').findOne({ key:'pos' }))) await db.collection('settings').insertOne({ key:'pos', seq:101, invoiceSeq:1, stockSeq:1, expenseSeq:1 });
  const count = await db.collection('tables').countDocuments();
  if (!count) await db.collection('tables').insertMany(Array.from({length:18},(_,i)=>({id:i+1,draft:[],sent:[]})));
  console.log('MongoDB connected:', db.databaseName);
}

const col = n => db.collection(n);

app.get('/api/state', async (_req,res)=>{
  try {
    const [menu,tables,kitchen,invoices,settings,inventory,stockIns,expenseTypes,expenses] = await Promise.all([
      col('menu').find({}).sort({id:1}).toArray(),
      col('tables').find({}).sort({id:1}).toArray(),
      col('orders').find({}).sort({createdAt:1}).toArray(),
      col('invoices').find({}).sort({time:-1}).toArray(),
      col('settings').findOne({key:'pos'}),
      col('inventory').find({}).sort({id:1}).toArray(),
      col('stockins').find({}).sort({time:-1}).toArray(),
      col('expensetypes').find({}).sort({id:1}).toArray(),
      col('expenses').find({}).sort({time:-1}).toArray()
    ]);
    res.json({menu,tables,kitchen,invoices,inventory,stockIns,expenseTypes,expenses,seq:settings?.seq||101,invoiceSeq:settings?.invoiceSeq||1});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.put('/api/menu', async (req,res)=>{
  try {
    const items = Array.isArray(req.body) ? req.body : [];
    if (!items.length) return res.status(400).json({error:'Menu cannot be empty'});
    const ops = items.map(x=>({updateOne:{filter:{id:x.id},update:{$set:{name:x.name,price:Number(x.price),cat:x.cat,active:!!x.active}},upsert:true}}));
    await col('menu').bulkWrite(ops);
    await col('menu').deleteMany({id:{$nin:items.map(x=>x.id)}});
    res.json({ok:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.put('/api/inventory', async (req,res)=>{
  try {
    const items = Array.isArray(req.body) ? req.body : [];
    const ops = items.map(x=>({updateOne:{filter:{id:x.id},update:{$set:{name:x.name,unit:x.unit,stock:Number(x.stock)||0,minStock:Number(x.minStock)||0}},upsert:true}}));
    if (ops.length) await col('inventory').bulkWrite(ops);
    await col('inventory').deleteMany({id:{$nin:items.map(x=>x.id)}});
    res.json({ok:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/stock-in', async (req,res)=>{
  try {
    const {ingredientId,qty,price,note}=req.body;
    const q=Number(qty), p=Number(price)||0;
    if (!q || q<=0) return res.status(400).json({error:'Số lượng nhập không hợp lệ'});
    const ingredient=await col('inventory').findOneAndUpdate({id:Number(ingredientId)},{$inc:{stock:q}},{returnDocument:'after'});
    if (!ingredient) return res.status(404).json({error:'Nguyên liệu không tồn tại'});
    const settings=await col('settings').findOneAndUpdate({key:'pos'},{$inc:{stockSeq:1}},{returnDocument:'before'});
    const n=settings?.stockSeq||1;
    const entry={id:`NK-${String(n).padStart(5,'0')}`,ingredientId:Number(ingredientId),ingredientName:ingredient.name,qty:q,price:p,total:q*p,note:note||'',time:new Date()};
    await col('stockins').insertOne(entry);
    res.json({entry,ingredient});
  } catch(e){res.status(500).json({error:e.message});}
});

app.put('/api/expense-types', async (req,res)=>{
  try {
    const items = Array.isArray(req.body) ? req.body : [];
    const ops = items.map(x=>({updateOne:{filter:{id:x.id},update:{$set:{name:x.name,amount:Number(x.amount)||0}},upsert:true}}));
    if (ops.length) await col('expensetypes').bulkWrite(ops);
    await col('expensetypes').deleteMany({id:{$nin:items.map(x=>x.id)}});
    res.json({ok:true});
  } catch(e){ res.status(500).json({error:e.message}); }
});

app.post('/api/expenses', async (req,res)=>{
  try {
    const {typeId,amount,month,note}=req.body;
    const a=Number(amount);
    if (!a || a<=0) return res.status(400).json({error:'Số tiền không hợp lệ'});
    if (!month) return res.status(400).json({error:'Thiếu tháng ghi nhận'});
    const type=await col('expensetypes').findOne({id:Number(typeId)});
    if (!type) return res.status(404).json({error:'Loại chi phí không tồn tại'});
    const settings=await col('settings').findOneAndUpdate({key:'pos'},{$inc:{expenseSeq:1}},{returnDocument:'before'});
    const n=settings?.expenseSeq||1;
    const entry={id:`CP-${String(n).padStart(5,'0')}`,typeId:Number(typeId),typeName:type.name,amount:a,month,note:note||'',time:new Date()};
    await col('expenses').insertOne(entry);
    res.json(entry);
  } catch(e){res.status(500).json({error:e.message});}
});

app.put('/api/table/:id', async (req,res)=>{
  try {
    const id=Number(req.params.id); const value=req.body;
    await col('tables').updateOne({id},{$set:{draft:value.draft||[],sent:value.sent||[]}}, {upsert:true});
    res.json({ok:true});
  } catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/tables', async (_req,res)=>{
  try {
    const last = await col('tables').find().sort({id:-1}).limit(1).toArray();
    const id = (last[0]?.id||0)+1;
    const table = {id,draft:[],sent:[]};
    await col('tables').insertOne(table);
    res.json(table);
  } catch(e){res.status(500).json({error:e.message});}
});

app.delete('/api/table/:id', async (req,res)=>{
  try {
    const id=Number(req.params.id);
    const t=await col('tables').findOne({id});
    if (!t) return res.status(404).json({error:'Bàn không tồn tại'});
    if ((t.draft&&t.draft.length)||(t.sent&&t.sent.length)) return res.status(400).json({error:'Bàn đang có món, không thể xóa'});
    await col('tables').deleteOne({id});
    res.json({ok:true});
  } catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/order', async (req,res)=>{
  try {
    const {table,items}=req.body;
    const settings=await col('settings').findOneAndUpdate({key:'pos'},{$inc:{seq:1}},{returnDocument:'before'});
    const seq=settings?.seq||101;
    const order={id:`P-${seq}`,table:Number(table),items,status:'cooking',createdAt:new Date()};
    await col('orders').insertOne(order);
    await col('tables').updateOne({id:Number(table)},{$push:{sent:order},$set:{draft:[]}});
    res.json(order);
  } catch(e){res.status(500).json({error:e.message});}
});

app.patch('/api/order/:id/ready', async (req,res)=>{
  try {
    const id=req.params.id;
    const order=await col('orders').findOneAndUpdate({id},{$set:{status:'ready',readyAt:new Date()}},{returnDocument:'after'});
    if (!order) return res.status(404).json({error:'Order not found'});
    await col('tables').updateOne({id:order.table,'sent.id':id},{$set:{'sent.$.status':'ready','sent.$.readyAt':order.readyAt}});
    res.json(order);
  } catch(e){res.status(500).json({error:e.message});}
});

app.post('/api/invoice', async (req,res)=>{
  try {
    const {table,total,method,items}=req.body;
    const settings=await col('settings').findOneAndUpdate({key:'pos'},{$inc:{invoiceSeq:1}},{returnDocument:'before'});
    const n=settings?.invoiceSeq||1;
    const invoice={id:`HD-${String(n).padStart(5,'0')}`,time:new Date(),table:Number(table),total:Number(total),method,items};
    await col('invoices').insertOne(invoice);
    await col('orders').deleteMany({table:Number(table)});
    await col('tables').updateOne({id:Number(table)},{$set:{draft:[],sent:[]}});
    res.json(invoice);
  } catch(e){res.status(500).json({error:e.message});}
});

app.get('/{*splat}', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const port=Number(process.env.PORT||3000);
connect().then(()=>app.listen(port,()=>console.log(`POS running at http://localhost:${port}`))).catch(err=>{console.error(err);process.exit(1)});
process.on('SIGINT', async()=>{await client.close();process.exit(0)});
