import express from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import * as cheerio from 'cheerio';
import nodemailer from 'nodemailer';

const app = express();
app.disable('x-powered-by');
app.use(express.json({limit:'32kb'}));
const PORT = Number(process.env.PORT || 3000);
const EVENTS = [
  {name:'Triftern', date:'31.01.2027'},
  {name:'Tettenweis', date:'05.02.2027'},
  {name:'Neuötting', date:'06.02.2027'},
  {name:'Eggenfelden', date:'06.02.2027'},
  {name:'Wurmannsquick', date:'07.02.2027'},
  {name:'Peterskirchen', date:'09.02.2027'}
];
const eventNames = EVENTS.map(x=>x.name);
const dir = process.env.DATA_DIR || './data'; fs.mkdirSync(dir,{recursive:true});
const db = new Database(path.join(dir,'fasching.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.exec(`
CREATE TABLE IF NOT EXISTS emails(id INTEGER PRIMARY KEY, uid TEXT UNIQUE, received_at TEXT, from_addr TEXT, subject TEXT, body TEXT, parsed_json TEXT, status TEXT DEFAULT 'Prüfen');
CREATE TABLE IF NOT EXISTS participants(id INTEGER PRIMARY KEY, email_id INTEGER, name TEXT, age TEXT, parade TEXT, contact_email TEXT, phone TEXT, notes TEXT, confidence TEXT, FOREIGN KEY(email_id) REFERENCES emails(id));
CREATE TABLE IF NOT EXISTS registrations(id INTEGER PRIMARY KEY, name TEXT NOT NULL, age INTEGER NOT NULL, email TEXT NOT NULL, phone TEXT NOT NULL, notes TEXT, created_at TEXT NOT NULL, mail_status TEXT NOT NULL DEFAULT 'pending');
CREATE TABLE IF NOT EXISTS registration_events(registration_id INTEGER NOT NULL, parade TEXT NOT NULL, PRIMARY KEY(registration_id,parade), FOREIGN KEY(registration_id) REFERENCES registrations(id));
CREATE TABLE IF NOT EXISTS deleted_imports(uid TEXT NOT NULL, parade TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY(uid,parade,name));
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
CREATE INDEX IF NOT EXISTS idx_reg_events_parade ON registration_events(parade);
CREATE INDEX IF NOT EXISTS idx_participants_parade ON participants(parade);
`);
// Legacy database compatibility: old installations may contain IMAP-derived participants.
const now = ()=>new Date().toISOString();
const clean = (v,max=300)=>String(v??'').replace(/[\x00-\x1f\x7f]/g,' ').replace(/\s+/g,' ').trim().slice(0,max);
const nameKey=v=>clean(v).normalize('NFKC').toLocaleLowerCase('de-DE');
const validEmail = v=>/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const escapeRegex = s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
function equal(a,b){const x=Buffer.from(String(a??'')),y=Buffer.from(String(b??''));return x.length===y.length&&crypto.timingSafeEqual(x,y);}
function token(){const payload=Buffer.from(JSON.stringify({exp:Date.now()+12*3600000})).toString('base64url');const sig=crypto.createHmac('sha256',process.env.SESSION_SECRET).update(payload).digest('base64url');return payload+'.'+sig;}
function auth(req){if(!process.env.SESSION_SECRET)return false;const raw=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('fasching_session='))?.slice(17);if(!raw)return false;const [p,s]=raw.split('.');if(!p||!s)return false;const sig=crypto.createHmac('sha256',process.env.SESSION_SECRET).update(p).digest('base64url');if(!equal(s,sig))return false;try{return JSON.parse(Buffer.from(p,'base64url').toString()).exp>Date.now();}catch{return false;}}
function guard(req,res,next){if(!auth(req))return res.status(401).json({error:'Bitte zuerst anmelden.'});next();}
function originGuard(req,res,next){const origin=req.headers.origin;if(origin){try{if(new URL(origin).host!==req.get('host'))return res.status(403).json({error:'Ungültige Anfrage.'});}catch{return res.status(403).json({error:'Ungültige Anfrage.'});}}next();}
app.use('/api',originGuard);
const attempts=new Map();
app.post('/api/login',(req,res)=>{const key=req.ip;const record=attempts.get(key)||{count:0,until:0};if(record.until>Date.now())return res.status(429).json({error:'Zu viele Versuche. Bitte in 15 Minuten erneut versuchen.'});if(!process.env.DASHBOARD_PASSWORD||!process.env.SESSION_SECRET)return res.status(503).json({error:'Dashboard noch nicht konfiguriert.'});if(!equal(req.body?.password,process.env.DASHBOARD_PASSWORD)){record.count++;if(record.count>=8){record.until=Date.now()+15*60000;record.count=0;}attempts.set(key,record);return res.status(401).json({error:'Passwort stimmt nicht.'});}attempts.delete(key);res.setHeader('Set-Cookie',`fasching_session=${token()}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=43200`);res.json({ok:true});});
app.post('/api/logout',(req,res)=>{res.setHeader('Set-Cookie','fasching_session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0');res.json({ok:true});});
app.get('/api/health',(_,res)=>res.json({ok:true}));
const regCounts=db.prepare('SELECT parade,COUNT(*) AS n FROM registration_events GROUP BY parade');
const importCounts=db.prepare(`SELECT parade,COUNT(*) AS n FROM participants p WHERE NOT EXISTS (SELECT 1 FROM registrations r WHERE lower(r.email)=lower(p.contact_email) AND lower(r.name)=lower(p.name)) GROUP BY parade`);
function counts(){const out=Object.fromEntries(eventNames.map(e=>[e,0]));for(const r of regCounts.all())if(r.parade in out)out[r.parade]+=r.n;for(const r of importCounts.all())if(r.parade in out)out[r.parade]+=r.n;return out;}
app.get('/api/events',(_,res)=>res.json({events:EVENTS.map(e=>({...e,count:counts()[e.name],limit:70}))}));

const addReg=db.prepare('INSERT INTO registrations(name,age,email,phone,notes,created_at) VALUES(?,?,?,?,?,?)');
const addRegEvent=db.prepare('INSERT INTO registration_events(registration_id,parade) VALUES(?,?)');
const setMail=db.prepare('UPDATE registrations SET mail_status=? WHERE id=?');
const reserve=db.transaction((data)=>{const c=counts();const existing=db.prepare(`SELECT r.name,e.parade FROM registrations r JOIN registration_events e ON e.registration_id=r.id UNION ALL SELECT name,parade FROM participants`).all();for(const event of data.events)if(existing.some(p=>p.parade===event&&nameKey(p.name)===nameKey(data.name)))throw new Error(`Dieser Name ist für ${event} bereits angemeldet.`);for(const event of data.events)if(c[event]>=70)throw new Error(`Für ${event} sind bereits alle 70 Plätze vergeben.`);const id=addReg.run(data.name,data.age,data.email,data.phone,data.notes,now()).lastInsertRowid;for(const e of data.events)addRegEvent.run(id,e);return id;});
app.post('/api/register',async(req,res)=>{const b=req.body||{};const name=clean(b.name,100),age=Number(b.age),email=clean(b.email,150),phone=clean(b.phone,50),notes=clean(b.notes,1000),events=b.events;
 if(name.length<3||!Number.isInteger(age)||age<18||age>110||!validEmail(email)||phone.length<5||!Array.isArray(events)||!events.length||events.length>6||new Set(events).size!==events.length||events.some(e=>!eventNames.includes(e)))return res.status(400).json({error:'Bitte alle Pflichtfelder prüfen. Teilnahme ab 18 Jahren.'});
 if(!process.env.GMX_EMAIL||!process.env.GMX_APP_PASSWORD)return res.status(503).json({error:'E-Mail-Versand noch nicht eingerichtet.'});
 let id;try{id=reserve({name,age,email,phone,notes,events});}catch(e){return res.status(409).json({error:e.message});}
 const body=`Name: ${name}\nFaschingsumzüge: ${events.join(', ')}\nE-Mail: ${email}\nTelefonnummer: ${phone}\nAlter: ${age}${notes?'\nAnmerkungen: '+notes:''}`;
 try{const smtp=nodemailer.createTransport({host:process.env.GMX_SMTP_HOST||'mail.gmx.net',port:Number(process.env.GMX_SMTP_PORT||587),secure:false,requireTLS:true,auth:{user:process.env.GMX_EMAIL,pass:process.env.GMX_APP_PASSWORD}});await smtp.sendMail({from:process.env.GMX_EMAIL,to:process.env.GMX_EMAIL,replyTo:email,subject:'Neue Faschings-Anmeldung 2027',text:body});setMail.run('sent',id);res.json({ok:true,message:'Danke! Deine Anmeldung wurde gespeichert und per E-Mail versendet.'});}
 catch(e){setMail.run('failed',id);console.error('SMTP:',e.message);res.status(202).json({ok:true,message:'Deine Anmeldung ist gespeichert. Die E-Mail konnte noch nicht zugestellt werden; der Veranstalter sieht den Hinweis im Dashboard.'});}
});

function htmlRows(html){if(!html)return[];const $=cheerio.load(html);return $('tr').map((_,tr)=>$(tr).find('th,td').map((__,td)=>clean($(td).text())).get()).get().filter(r=>Array.isArray(r)&&r.length);}
function parseMessage(text,html){const rows=htmlRows(html);const lines=[...(text||'').split(/\r?\n/),...rows.map(r=>r.join(' | '))];const combined=lines.join('\n');const found=eventNames.filter(e=>new RegExp(escapeRegex(e),'i').test(combined));
 const field=(label)=>{for(const line of lines){const m=line.match(new RegExp('^\\s*(?:'+label+')\\s*[:=|]\\s*(.+)$','i'));if(m)return clean(m[1].split('|')[0]);}return '';};
 const name=field('name|vorname\\s*und\\s*nachname|teilnehmer(?:name)?'),age=field('alter|age'),email=field('e-?mail|email'),phone=field('telefon(?:nummer)?|handy|phone|mobil'),notes=field('anmerkungen?|bemerkungen?|notizen?');
 const records=[];
 if(name){for(const parade of (found.length?found:['']))records.push({name,age,parade,email,phone,notes,confidence:age&&parade?'Hoch':'Prüfen'});}
 else {for(const row of rows){if(row.length<3||/^(name|alter|umzug)$/i.test(row[0]))continue;const parade=eventNames.find(e=>row.some(c=>c.toLowerCase().includes(e.toLowerCase())))||'';const candidate=row.find(c=>/^[\p{L}][\p{L}.' -]+\s+[\p{L}][\p{L}.' -]+$/u.test(c)&&!eventNames.includes(c));const rowAge=row.find(c=>/^\d{2,3}$/.test(c))||'';if(candidate&&(parade||rowAge))records.push({name:candidate,age:rowAge,parade,email,phone,notes,confidence:parade&&rowAge?'Mittel':'Prüfen'});}}
 if(!records.length)records.push({name:'Nicht erkannt',age:'',parade:found.length===1?found[0]:'',email,phone,notes,confidence:'Prüfen'});
 return {records,foundEvents:found};
}
let lastRefresh=db.prepare("SELECT value FROM settings WHERE key='lastRefresh'").get()?.value||null,refreshing=false;
const seen=db.prepare('SELECT id FROM emails WHERE uid=?');
const addEmail=db.prepare('INSERT OR IGNORE INTO emails(uid,received_at,from_addr,subject,body,parsed_json,status) VALUES(?,?,?,?,?,?,?)');
const addParticipant=db.prepare('INSERT INTO participants(email_id,name,age,parade,contact_email,phone,notes,confidence) VALUES(?,?,?,?,?,?,?,?)');
const tombstone=db.prepare('SELECT 1 FROM deleted_imports WHERE uid=? AND parade=? AND name=?');
const storeMessage=db.transaction(msg=>{const r=addEmail.run(msg.uid,msg.date,msg.from,msg.subject,msg.body,JSON.stringify(msg.extracted),msg.message?'Nachricht':msg.extracted.records.some(r=>r.confidence==='Prüfen')?'Prüfen':'Ausgewertet');if(!r.changes||msg.message)return;const emailId=r.lastInsertRowid;for(const p of msg.extracted.records){if(!tombstone.get(msg.uid,p.parade,p.name)&&!db.prepare(`SELECT name FROM participants WHERE parade=? UNION ALL SELECT r.name FROM registrations r JOIN registration_events e ON e.registration_id=r.id WHERE e.parade=?`).all(p.parade,p.parade).some(x=>nameKey(x.name)===nameKey(p.name)))addParticipant.run(emailId,p.name,p.age,p.parade,p.email,p.phone,p.notes,p.confidence);}});
async function refreshMailbox(){if(refreshing)return {ok:true,skipped:true,refreshedAt:lastRefresh};if(!process.env.GMX_EMAIL||!process.env.GMX_APP_PASSWORD)throw new Error('GMX-Zugangsdaten fehlen.');refreshing=true;let client;
 try{client=new ImapFlow({host:process.env.GMX_IMAP_HOST||'imap.gmx.net',port:Number(process.env.GMX_IMAP_PORT||993),secure:true,auth:{user:process.env.GMX_EMAIL,pass:process.env.GMX_APP_PASSWORD},logger:false});await client.connect();const lock=await client.getMailboxLock('INBOX');try{const uids=await client.search({all:true},{uid:true});if(uids.length){for await(const msg of client.fetch(uids,{uid:true,source:true,internalDate:true},{uid:true})){const uid=String(msg.uid);if(seen.get(uid))continue;const mail=await simpleParser(msg.source);const subject=clean(mail.subject),body=mail.text||'',html=typeof mail.html==='string'?mail.html:'';if(!/fasching|faschings|umzug|faschingszug/i.test(subject+'\n'+body+'\n'+html))continue;const extracted=parseMessage(body,html);if(subject==='Neue Faschings-Anmeldung 2027'&&mail.from?.value?.[0]?.address?.toLowerCase()===process.env.GMX_EMAIL?.toLowerCase()){addEmail.run(uid,(msg.internalDate||new Date()).toISOString(),clean(mail.from?.text),subject,body.slice(0,30000),'{}','Ausgewertet');continue;}const message=/abmeld|absag|stornier|nicht (mehr )?(teilnehmen|mitfahren)/i.test(subject+' '+body)||!(/anmeld|registrier/i.test(subject)&&extracted.records.some(p=>p.name!=='Nicht erkannt'&&p.parade&&Number(p.age)>=18));storeMessage({message,uid,date:(msg.internalDate||new Date()).toISOString(),from:clean(mail.from?.value?.[0]?.address||mail.from?.text),subject,body:body.slice(0,30000),extracted});}}}finally{lock.release();}lastRefresh=now();db.prepare("INSERT INTO settings(key,value) VALUES('lastRefresh',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(lastRefresh);return {ok:true,refreshedAt:lastRefresh};}finally{try{await client?.logout();}catch{}refreshing=false;}}
app.post('/api/refresh',guard,async(_,res)=>{try{res.json(await refreshMailbox());}catch(e){console.error('IMAP:',e.message);res.status(502).json({error:'Postfach konnte nicht abgerufen werden. Bitte GMX-Einstellungen prüfen.'});}});
app.get('/api/dashboard',guard,(_,res)=>{const registrations=db.prepare(`SELECT r.id,r.name,r.age,r.email AS contact_email,r.phone,r.notes,r.created_at,r.mail_status,e.parade FROM registrations r JOIN registration_events e ON e.registration_id=r.id ORDER BY r.created_at DESC`).all().map(r=>({...r,source:'registration'}));const imported=db.prepare(`SELECT p.id,p.name,p.age,p.contact_email,p.phone,p.notes,p.parade,p.confidence,e.received_at AS created_at FROM participants p JOIN emails e ON e.id=p.email_id WHERE NOT EXISTS(SELECT 1 FROM registrations r WHERE lower(r.email)=lower(p.contact_email) AND lower(r.name)=lower(p.name)) ORDER BY e.received_at DESC`).all().map(r=>({...r,source:'import'}));const emails=db.prepare("SELECT id,received_at,from_addr,subject,status,body FROM emails WHERE status IN ('Nachricht','Prüfen') ORDER BY received_at DESC").all();res.json({events:EVENTS,participants:[...registrations,...imported],emails,counts:counts(),lastRefresh});});
app.delete('/api/participants/:source/:id',guard,(req,res)=>{const id=Number(req.params.id);if(!Number.isSafeInteger(id)||id<=0)return res.status(400).json({error:'Ungültige ID.'});if(req.params.source==='registration'){const result=db.transaction(()=>{const parade=clean(req.query.parade,80);if(!eventNames.includes(parade))return false;const deleted=db.prepare('DELETE FROM registration_events WHERE registration_id=? AND parade=?').run(id,parade);if(!deleted.changes)return false;const remaining=db.prepare('SELECT COUNT(*) AS n FROM registration_events WHERE registration_id=?').get(id).n;if(!remaining)db.prepare('DELETE FROM registrations WHERE id=?').run(id);return true;})();if(!result)return res.status(404).json({error:'Nicht gefunden.'});}else if(req.params.source==='import'){const p=db.prepare('SELECT p.*,e.uid FROM participants p JOIN emails e ON e.id=p.email_id WHERE p.id=?').get(id);if(!p)return res.status(404).json({error:'Nicht gefunden.'});db.transaction(()=>{db.prepare('INSERT OR IGNORE INTO deleted_imports(uid,parade,name) VALUES(?,?,?)').run(p.uid,p.parade,p.name);db.prepare('DELETE FROM participants WHERE id=?').run(id);})();}else return res.status(400).json({error:'Ungültige Quelle.'});res.json({ok:true});});
app.post('/api/messages/:id/done',guard,(req,res)=>{db.prepare("UPDATE emails SET status='Erledigt' WHERE id=? AND status IN ('Nachricht','Prüfen')").run(Number(req.params.id));res.json({ok:true});});
app.use(express.static(path.join(process.cwd(),'public')));
app.listen(PORT,()=>{console.log(`Fasching 2027 läuft auf Port ${PORT}`);setTimeout(()=>refreshMailbox().catch(e=>console.error('IMAP:',e.message)),8000);setInterval(()=>refreshMailbox().catch(e=>console.error('IMAP:',e.message)),Math.max(5,Number(process.env.AUTO_REFRESH_MINUTES)||5)*60000);});
