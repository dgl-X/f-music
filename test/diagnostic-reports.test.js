import assert from 'node:assert/strict';
import test from 'node:test';
import { createDiagnosticReportsHttpController, createDiagnosticReportsService, normalizeDiagnosticReport } from '../src/diagnostic-reports.js';

test('diagnostic report accepts only bounded safe detail sections', () => {
  const report=normalizeDiagnosticReport({
    description:'  Переключение зависло  ',app_version:'1.0.45',device:'Pixel',android_version:'16',
    details:{track:{id:'one'},network:{type:'wifi'},secret:'must-not-leave'},
  });
  assert.equal(report.description,'Переключение зависло');
  assert.deepEqual(JSON.parse(report.detailsJson),{track:{id:'one'},network:{type:'wifi'}});
  assert.throws(()=>normalizeDiagnosticReport({description:' '}),error=>error.code==='invalid_report');
  assert.throws(()=>normalizeDiagnosticReport({description:'x',details:{events:'x'.repeat(40001)}}),error=>error.code==='report_too_large');
});

test('diagnostic report service preserves response shape and tolerates legacy malformed details', async () => {
  const calls=[];
  const db={prepare(sql){return{
    async run(...params){calls.push({sql,params});if(sql.startsWith('INSERT'))return{rows:[{id:'12',created_at:'now'}]};return{changes:1};},
    async all(){return[{id:12,description:'one',details_json:'{broken',username:'user'}];},
  };}};
  const reports=createDiagnosticReportsService({db,retentionDays:90,fixedRetentionDays:14});
  assert.deepEqual(await reports.create({userId:7,body:{description:'test',details:{player:{playing:true}}}}),{id:12,created_at:'now'});
  assert.equal(calls[0].params[0],7);
  assert.deepEqual((await reports.list())[0].details,{});
  assert.equal(await reports.setStatus(12,'fixed'),true);
  await assert.rejects(()=>reports.setStatus(12,'unknown'),error=>error.code==='invalid_report_status');
  assert.equal(await reports.cleanup(),1);
  assert.deepEqual(calls.at(-1).params,[90,14]);
});

function httpSetup(reports) {
  const responses=[];
  const controller=createDiagnosticReportsHttpController({
    reports,async readJson(req){return req.body||{};},
    sendJson(res,status,value){responses.push({status,value});},
  });
  return {controller,responses};
}

test('diagnostic report HTTP routes keep submission available and administration protected', async () => {
  const reports={
    async create({userId}){assert.equal(userId,8);return{id:3,created_at:'now'};},
    async list(){return[{id:3}];},async remove(){return false;},async setStatus(){return true;},
  };
  const submitted=httpSetup(reports);
  assert.equal(await submitted.controller.handle({method:'POST',body:{description:'x'}},{},new URL('http://local/api/reports'),{id:8,is_admin:0}),true);
  assert.equal(submitted.responses[0].status,201);

  const denied=httpSetup(reports);
  await denied.controller.handle({method:'GET'},{},new URL('http://local/api/admin/reports'),{id:8,is_admin:0});
  assert.equal(denied.responses[0].status,403);

  const admin=httpSetup(reports);
  await admin.controller.handle({method:'GET'},{},new URL('http://local/api/admin/reports'),{id:1,is_admin:1});
  assert.deepEqual(admin.responses[0],{status:200,value:{items:[{id:3}]}});
  await admin.controller.handle({method:'DELETE'},{},new URL('http://local/api/admin/reports/99'),{id:1,is_admin:1});
  assert.equal(admin.responses[1].status,404);
  assert.equal(await admin.controller.handle({method:'GET'},{},new URL('http://local/api/tracks'),{id:1,is_admin:1}),false);
});
