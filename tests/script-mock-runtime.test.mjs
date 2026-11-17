import test from "node:test";
import assert from "node:assert/strict";
import { runScript, runScriptSequence } from "../src/scripts.mjs";

// Real QuickJS cases for exact-commit CI only, not local source-only checks.
test("script Mock keeps JSON primitives and differentiates array selection from sequence repetition", async () => {
  const result = await runScript(
    `
      const template={
        'fixed|3':99,
        'negative|-4--2':0,
        'repeat|2':['a','b'],
        'select|1':['chosen'],
        'sequence|1-1':[false,null],
        'empty|2':[],
        nested:{'n|8-8':0},
        unicode:'空 格🙂',
        ordinary:[0,false,null,'']
      };
      const before=JSON.stringify(template);
      const generated=Mock.mock(template);
      pm.environment.set('primitive',[Mock.mock(null),Mock.mock(false),Mock.mock(0),Mock.mock('')]);
      pm.environment.set('generated',generated);
      pm.environment.set('before',before);
      pm.environment.set('after',JSON.stringify(template));
      generated.repeat[0]='changed result';
      pm.environment.set('second',Mock.mock(template));
    `,
    { variables: {} },
  );
  assert.deepEqual(result.variables.primitive, [null, false, 0, ""]);
  assert.equal(result.variables.before, result.variables.after);
  for (const generated of [
    result.variables.generated,
    result.variables.second,
  ]) {
    assert.equal(generated.fixed, 3);
    assert.equal(Number.isInteger(generated.negative), true);
    assert(generated.negative >= -4 && generated.negative <= -2);
    assert.equal(generated.select, "chosen");
    assert.deepEqual(generated.sequence, [false, null]);
    assert.deepEqual(generated.empty, []);
    assert.deepEqual(generated.nested, { n: 8 });
    assert.equal(generated.unicode, "空 格🙂");
    assert.deepEqual(generated.ordinary, [0, false, null, ""]);
  }
  // Scoped set currently stores the guest value until serialization. Either
  // way, the second generated tree and caller-owned template must be fresh.
  assert.deepEqual(result.variables.second.repeat, ["a", "b", "a", "b"]);
  assert.deepEqual(JSON.parse(result.variables.after)["repeat|2"], ["a", "b"]);
});

test("script Mock exposes only its frozen single-argument facade and grants no modules or XHR", async () => {
  const result = await runScript(
    `
      const original=Mock.mock;
      try{Mock.mock=()=>({bypass:true});}catch{}
      try{Mock.Random={integer:()=>1};}catch{}
      const failures=[];
      for(const args of [[],['/registered-url',{}],['/registered-url','GET',{}]]){
        try{Mock.mock(...args);failures.push(null);}catch(error){failures.push(error.message);}
      }
      const modules=['mockjs','apipost-mock','fs','node:vm','worker_threads'].map(name=>{
        try{require(name);return false;}catch(error){return error.message.includes('不允许');}
      });
      pm.environment.set('facade',{
        keys:Object.keys(Mock),frozen:Object.isFrozen(Mock),unchanged:Mock.mock===original,
        handler:typeof Mock.Handler,random:typeof Mock.Random,xhr:typeof XMLHttpRequest,
        failures,modules,positive:Mock.mock({ok:true})
      });
    `,
    { variables: {} },
  );
  const facade = result.variables.facade;
  assert.deepEqual(facade.keys, ["mock"]);
  assert.equal(facade.frozen, true);
  assert.equal(facade.unchanged, true);
  assert.equal(facade.handler, "undefined");
  assert.equal(facade.random, "undefined");
  assert.equal(facade.xhr, "undefined");
  assert.deepEqual(
    facade.failures,
    Array(3).fill("Mock模板: 仅支持单个JSON模板参数"),
  );
  assert.deepEqual(facade.modules, [true, true, true, true, true]);
  assert.deepEqual(facade.positive, { ok: true });
});

test("script Mock private core ignores ordinary function-local and user-script lexical Math shadows", async () => {
  const result = await runScript(
    `
      const Math={random:()=>1e100,round:()=>-999};
      pm.environment.set('fromFunction',utils.mockWithLocalMath());
      pm.environment.set('fromScript',Mock.mock({'number|4-4':0,'rows|2':[0]}));
      pm.environment.set('shadowIsLocal',Math.random()===1e100);
    `,
    {
      variables: {},
      functions: [
        {
          name: "mockWithLocalMath",
          kind: "script",
          body: "const Math={random:()=>1e100,round:()=>-999};return Mock.mock({'number|3-3':0,'rows|2':[0]});",
        },
      ],
    },
  );
  assert.deepEqual(result.variables.fromFunction, { number: 3, rows: [0, 0] });
  assert.deepEqual(result.variables.fromScript, { number: 4, rows: [0, 0] });
  assert.equal(result.variables.shadowIsLocal, true);
});

test("script Mock rejects placeholder code and accessors without evaluating data or silently falling back", async () => {
  const result = await runScript(
    `
      globalThis.__mockDataCode=0;
      let getterCalls=0,toJSONCalls=0;
      const getter={};
      Object.defineProperty(getter,'value',{enumerable:true,get(){getterCalls++;return 1;}});
      const serializer={toJSON(){toJSONCalls++;return {safe:true};}};
      const errors=[];
      for(const value of [
        {value:'@missing(globalThis.__mockDataCode=1)'},
        {value:'person@example.test'},
        getter,serializer
      ]){
        try{Mock.mock(value);errors.push(null);}catch(error){errors.push(error.message);}
      }
      pm.environment.set('evidence',{errors,getterCalls,toJSONCalls,executed:globalThis.__mockDataCode,recovery:Mock.mock({safe:true})});
      delete globalThis.__mockDataCode;
    `,
    { variables: {} },
  );
  const evidence = result.variables.evidence;
  assert.equal(evidence.errors.length, 4);
  assert.deepEqual(evidence.errors, [
    "Mock模板: 暂不支持占位符或含@字符串",
    "Mock模板: 暂不支持占位符或含@字符串",
    "Mock模板: 不支持访问器或隐藏属性",
    "Mock模板: 只支持JSON数据树",
  ]);
  assert.equal(evidence.getterCalls, 0);
  assert.equal(evidence.toJSONCalls, 0);
  assert.equal(evidence.executed, 0);
  assert.deepEqual(evidence.recovery, { safe: true });
});

for (const [name, mutate, restore] of [
  [
    "Math.random replacement",
    "const saved=Math.random;Math.random=()=>1e100;",
    "Math.random=saved;",
  ],
  [
    "Array.prototype.push replacement",
    "const saved=Array.prototype.push;Array.prototype.push=function(){throw Error('untrusted push executed');};",
    "Array.prototype.push=saved;",
  ],
  [
    "inherited enumerable getter",
    "let calls=0;Object.defineProperty(Object.prototype,'mockInherited',{configurable:true,enumerable:true,get(){calls++;return '@missing(globalThis.__unexpected=true)';}});",
    "delete Object.prototype.mockInherited;if(calls!==0)throw Error('inherited getter executed');",
  ],
  [
    "function-owned call override",
    "const target=Object.prototype.toString;Object.defineProperty(target,'call',{configurable:true,value(){throw Error('untrusted call executed');}});",
    "delete target.call;",
  ],
])
  test(
    "script Mock refuses " + name + " before invoking the public core",
    async () => {
      const result = await runScript(
        `
        ${mutate}
        let failure;
        try{Mock.mock({'rows|2':[{}]});}catch(error){failure=error.message;}
        finally{${restore}}
        pm.environment.set('failure',failure);
        pm.environment.set('recovery',Mock.mock({restored:true}));
      `,
        { variables: {} },
      );
      assert.equal(result.variables.failure, "Mock模板: 内建对象已修改");
      assert.doesNotMatch(
        result.variables.failure,
        /not defined|untrusted .* executed/,
      );
      assert.deepEqual(result.variables.recovery, { restored: true });
    },
  );

test("script Mock rechecks primordials after Proxy descriptor traps and never feeds that Proxy to the core", async () => {
  const result = await runScript(
    `
      let traps=0,getterCalls=0,failure;
      const proxy=new Proxy({safe:1},{ownKeys(target){
        traps++;
        Object.defineProperty(Object.prototype,'mockProxyPollution',{
          configurable:true,enumerable:true,get(){getterCalls++;return '@missing(globalThis.__unexpected=true)';}
        });
        return Reflect.ownKeys(target);
      }});
      try{Mock.mock(proxy);}catch(error){failure=error.message;}
      finally{delete Object.prototype.mockProxyPollution;}
      pm.environment.set('evidence',{traps,getterCalls,failure,recovery:Mock.mock({safe:2})});
    `,
    { variables: {} },
  );
  const evidence = result.variables.evidence;
  assert(
    evidence.traps >= 1,
    "this test deliberately exercises a guest Proxy trap",
  );
  assert.equal(evidence.getterCalls, 0);
  assert.equal(evidence.failure, "Mock模板: 内建对象已修改");
  assert.doesNotMatch(evidence.failure, /not defined|is not a function/);
  assert.deepEqual(evidence.recovery, { safe: 2 });
});

const mockUsage = (result) => ({
  mockCalls: result.usage.mockCalls,
  mockNodes: result.usage.mockNodes,
  mockBytes: result.usage.mockBytes,
});

test("script Mock accepts exact lower caller quotas and reports the trusted work debit", async () => {
  const result = await runScript(
    "pm.environment.set('values',[Mock.mock(0),Mock.mock(0)]);",
    { variables: {} },
    { mockCallLimit: 2, mockNodeLimit: 2, mockByteLimit: 2 },
  );
  assert.deepEqual(result.variables.values, [0, 0]);
  assert.deepEqual(mockUsage(result), {
    mockCalls: 2,
    mockNodes: 2,
    mockBytes: 2,
  });
});

for (const [name, rejected, expected] of [
  [
    "invalid JSON data",
    "try{Mock.mock('@bad');}catch(error){failure=error.message;}",
    "Mock模板: 暂不支持占位符或含@字符串",
  ],
  [
    "wrong argument count",
    "try{Mock.mock();}catch(error){failure=error.message;}",
    "Mock模板: 仅支持单个JSON模板参数",
  ],
  [
    "constructor invocation",
    "try{new Mock.mock({value:1});}catch(error){failure=error.message;}",
    "Mock模板: 不支持构造调用",
  ],
  [
    "modified primordial",
    "const old=Math.random;Math.random=()=>2;try{Mock.mock(0);}catch(error){failure=error.message;}finally{Math.random=old;}",
    "Mock模板: 内建对象已修改",
  ],
])
  test(
    "script Mock charges a caught " + name + " attempt before validation",
    async () => {
      const result = await runScript(
        `let failure;${rejected}pm.environment.set('failure',failure);pm.environment.set('value',Mock.mock(0));`,
        { variables: {} },
        { mockCallLimit: 2, mockNodeLimit: 2, mockByteLimit: 2 },
      );
      assert.equal(result.variables.failure, expected);
      assert.equal(result.variables.value, 0);
      assert.deepEqual(mockUsage(result), {
        mockCalls: 2,
        mockNodes: 1,
        mockBytes: 1,
      });
    },
  );

const cumulativeCases = [
  {
    name: "call",
    limits: { mockCallLimit: 2, mockNodeLimit: 10, mockByteLimit: 100 },
    expression: "0",
    admitted: 2,
    scalarBytes: 1,
  },
  {
    name: "node",
    limits: { mockCallLimit: 10, mockNodeLimit: 2, mockByteLimit: 100 },
    expression: "0",
    admitted: 2,
    scalarBytes: 1,
  },
  {
    name: "byte",
    limits: { mockCallLimit: 10, mockNodeLimit: 10, mockByteLimit: 4 },
    expression: "null",
    admitted: 1,
    scalarBytes: 4,
  },
];
for (const {
  name,
  limits,
  expression,
  admitted,
  scalarBytes,
} of cumulativeCases) {
  test(
    "script Mock " +
      name +
      " exhaustion remains sticky when caught and a fresh independent run recovers",
    async () => {
      const result = await runScript(
        `
        const values=[],errors=[];
        for(let i=0;i<${admitted + 2};i++){
          try{values.push(Mock.mock(${expression}));}catch(error){errors.push(error.message);}
        }
        pm.environment.set('values',values);
        pm.environment.set('errors',errors);
      `,
        { variables: {} },
        limits,
      );
      assert.deepEqual(
        result.variables.values,
        Array(admitted).fill(JSON.parse(expression)),
      );
      assert.deepEqual(
        result.variables.errors,
        Array(2).fill("Mock模板额度已用尽"),
      );
      // Saturation records consumed credits, not an assertion that the rejected
      // work actually ran. It carries terminal exhaustion across later scopes.
      assert.deepEqual(mockUsage(result), {
        mockCalls: limits.mockCallLimit,
        mockNodes: limits.mockNodeLimit,
        mockBytes: limits.mockByteLimit,
      });
      const fresh = await runScript(
        `pm.environment.set('value',Mock.mock(${expression}));`,
        { variables: {} },
        limits,
      );
      assert.equal(fresh.variables.value, JSON.parse(expression));
      assert.deepEqual(mockUsage(fresh), {
        mockCalls: 1,
        mockNodes: 1,
        mockBytes: scalarBytes,
      });
    },
  );

  test(
    "script Mock " +
      name +
      " credits cannot reset at an ordinary script scope boundary",
    async () => {
      const stages = Array.from({ length: admitted + 1 }, (_, index) => ({
        name: "scope-" + index,
        code: `Mock.mock(${expression});`,
      }));
      await assert.rejects(
        runScriptSequence(stages, { variables: {} }, limits),
        (error) => {
          assert.equal(error.message, "脚本Promise被拒绝: Mock模板额度已用尽");
          assert.equal(error.scriptScope, "scope-" + admitted);
          assert.equal(error.sequenceActivity.length, admitted);
          for (const activity of error.sequenceActivity) {
            assert.equal(activity.mockCalls, 1);
            assert.equal(activity.mockNodes, 1);
            assert.equal(activity.mockBytes, scalarBytes);
          }
          return true;
        },
      );
    },
  );

  test(
    "caught script Mock " +
      name +
      " exhaustion cannot be replenished by the next fresh scope VM",
    async () => {
      await assert.rejects(
        runScriptSequence(
          [
            {
              name: "caught-exhaustion",
              code: `
              let failure;
              for(let i=0;i<${admitted + 1};i++){
                try{Mock.mock(${expression});}catch(error){failure=error.message;}
              }
              if(failure!=='Mock模板额度已用尽')throw Error('expected caught quota refusal');
            `,
            },
            { name: "after-caught-exhaustion", code: "Mock.mock(0);" },
          ],
          { variables: {} },
          limits,
        ),
        (error) => {
          assert.equal(error.message, "脚本Promise被拒绝: Mock模板额度已用尽");
          assert.equal(error.scriptScope, "after-caught-exhaustion");
          assert.equal(error.sequenceActivity.length, 1);
          assert.equal(
            error.sequenceActivity[0].mockCalls,
            limits.mockCallLimit,
          );
          assert.equal(
            error.sequenceActivity[0].mockNodes,
            limits.mockNodeLimit,
          );
          assert.equal(
            error.sequenceActivity[0].mockBytes,
            limits.mockByteLimit,
          );
          return true;
        },
      );
    },
  );
}

test("script Mock array selection reserves every generated candidate rather than only its selected scalar", async () => {
  const code =
    "pm.environment.set('selected',Mock.mock({'choice|1':[0,0,0]}));";
  const complete = await runScript(
    code,
    { variables: {} },
    {
      mockCallLimit: 1,
      mockNodeLimit: 6,
      mockByteLimit: 18,
    },
  );
  assert.deepEqual(complete.variables.selected, { choice: 0 });
  assert.deepEqual(mockUsage(complete), {
    mockCalls: 1,
    mockNodes: 6,
    mockBytes: 18,
  });
  for (const limits of [
    { mockCallLimit: 1, mockNodeLimit: 5, mockByteLimit: 18 },
    { mockCallLimit: 1, mockNodeLimit: 6, mockByteLimit: 17 },
  ])
    await assert.rejects(runScript(code, { variables: {} }, limits), {
      message: "脚本Promise被拒绝: Mock模板额度已用尽",
    });
});

test("script Mock caller limits reject negative, fractional, nonnumeric and oversized quotas", () => {
  for (const options of [
    { mockCallLimit: -1 },
    { mockCallLimit: 1001 },
    { mockCallLimit: 0.5 },
    { mockNodeLimit: "2" },
    { mockNodeLimit: 10001 },
    { mockByteLimit: NaN },
    { mockByteLimit: Infinity },
    { mockByteLimit: 1048577 },
  ])
    assert.throws(() => runScript("", { variables: {} }, options), {
      message: "脚本预算无效",
    });
});

for (const [name, expressions, expected] of [
  [
    "prototype keys and projected collisions",
    [
      `JSON.parse('{"__proto__":1}')`,
      `({'constructor|1':0})`,
      `({a:1,'a|2':1})`,
    ],
    ["禁止原型属性", "禁止原型属性", "规则投影后属性重名"],
  ],
  [
    "unsupported mutation and typed rules",
    [`({'id|+1':1})`, `({'n|1.2':1})`, `({'a|2':'x'})`, `({'a|-1':[1]})`],
    [
      "不支持的键规则",
      "不支持的键规则",
      "仅数字或数组支持键规则",
      "数组范围无效",
    ],
  ],
  [
    "oversized nested and byte expansion",
    [
      `({'a|100':[{'b|100':[1]}]})`,
      `({'a|3':['x'.repeat(30000)]})`,
      `('x'.repeat(65535))`,
    ],
    ["输入或展开额度超限", "输入或展开额度超限", "输入或展开结果超过64KiB"],
  ],
])
  test(
    "script Mock rejects " +
      name +
      " before reserving core work and a fresh valid call still succeeds",
    async () => {
      const result = await runScript(
        `const errors=[];for(const value of [${expressions.join(",")}]){try{Mock.mock(value);errors.push(null);}catch(error){errors.push(error.message);}}
       pm.environment.set('errors',errors);pm.environment.set('recovery',Mock.mock(null));`,
        { variables: {} },
      );
      assert.deepEqual(
        result.variables.errors,
        expected.map((message) => "Mock模板: " + message),
      );
      assert.equal(result.variables.recovery, null);
      assert.deepEqual(mockUsage(result), {
        mockCalls: expressions.length + 1,
        mockNodes: 1,
        mockBytes: 4,
      });
    },
  );
