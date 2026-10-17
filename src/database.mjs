import {DatabaseSync} from 'node:sqlite';
export function querySQLite(filename,sql,parameters=[]){if(typeof filename!=='string'||!filename.trim())throw Error('数据库路径为空');if(typeof sql!=='string'||sql.length>50000)throw Error('SQL 无效');if(!/^\s*(SELECT\b|WITH\b|EXPLAIN\b)/i.test(sql))throw Error('仅支持只读 SELECT / WITH / EXPLAIN 查询');const db=new DatabaseSync(filename,{readOnly:true,allowExtension:false});try{const statement=db.prepare(sql);const columns=statement.columns().map(c=>c.name),rows=[];let truncated=false;for(const row of statement.iterate(...parameters)){if(rows.length>=1000){truncated=true;break;}rows.push(Object.fromEntries(Object.entries(row).map(([k,v])=>[k,typeof v==='bigint'?String(v):v])));}return {columns,rows,truncated,limit:1000};}finally{db.close();}}
export async function querySQLiteBounded(filename,sql,parameters=[]){
  const {Worker}=await import('node:worker_threads');
  return new Promise((resolve,reject)=>{
    const worker=new Worker(new URL('./database-worker.mjs',import.meta.url),{
      workerData:{filename,sql,parameters},resourceLimits:{maxOldGenerationSizeMb:64}
    });
    const timer=setTimeout(()=>{worker.terminate();reject(Error('数据库查询超过 2 秒，已终止'));},2000);
    worker.once('message',message=>{clearTimeout(timer);worker.terminate();message.error?reject(Error(message.error)):resolve(message.result);});
    worker.once('error',error=>{clearTimeout(timer);reject(error);});
    worker.once('exit',code=>{clearTimeout(timer);if(code!==0)reject(Error('数据库查询进程已退出'));});
  });
}
