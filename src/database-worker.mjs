import {parentPort,workerData} from 'node:worker_threads';
import {querySQLite} from './database.mjs';
try { parentPort.postMessage({result:querySQLite(workerData.filename,workerData.sql,workerData.parameters)}); }
catch(error) { parentPort.postMessage({error:error.message}); }
