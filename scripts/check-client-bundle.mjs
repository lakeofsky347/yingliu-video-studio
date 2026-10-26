import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';

export const CLIENT_SEED_MODULES=Object.freeze(['react','react/jsx-runtime']);
const seeds=new Set(CLIENT_SEED_MODULES),nodeRequire=createRequire(import.meta.url);

/** Check the shipped factory, including dependencies referenced only by deferred code. */
export function checkClientBundle(source,filename='lib/client.js'){
  const syntax=ts.createSourceFile(filename,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS),externals=new Set();
  if(syntax.parseDiagnostics.length)throw new Error(`Invalid client bundle syntax: ${filename}`);
  function fail(node,message){
    const position=syntax.getLineAndCharacterOfPosition(node.getStart(syntax));
    throw new Error(`${filename}:${position.line+1}:${position.character+1}: ${message}`);
  }
  function visit(node){
    if(ts.isImportDeclaration(node)||ts.isExportDeclaration(node)&&node.moduleSpecifier)fail(node,'Client factory must contain bundled code, not ESM imports');
    if(ts.isCallExpression(node)){
      if(node.expression.kind===ts.SyntaxKind.ImportKeyword)fail(node,'Unregistered dynamic import in client factory');
      if(ts.isIdentifier(node.expression)&&node.expression.text==='require'){
        const argument=node.arguments[0];
        if(node.arguments.length!==1||!argument||!ts.isStringLiteralLike(argument))fail(node,'Dynamic require cannot be resolved by the DSH module table');
        const name=argument.text;
        if(!seeds.has(name))fail(node,`require(${JSON.stringify(name)}) is not a DSH seed; bundle this dependency into the client factory`);
        externals.add(name);
      }
    }
    ts.forEachChild(node,visit);
  }
  visit(syntax);
  let count=0;
  const loader={load(definition){
    if(++count!==1||definition.id!=='yingliu-video-studio'||typeof definition.factory!=='function')throw new Error('Unexpected client factory registration');
    const exports=definition.factory(name=>{
      if(!seeds.has(name))throw new Error(`client-modules: require(${JSON.stringify(name)}) missed the module table`);
      return nodeRequire(name);
    });
    if(typeof exports?.apply!=='function'||!Array.isArray(exports.inject))throw new Error('Client factory must export apply and inject');
  }};
  runInNewContext(source,{window:{__ModuleLoader__:loader},TextEncoder,TextDecoder,Event,EventTarget,CustomEvent,console},{filename,timeout:5000});
  if(count!==1)throw new Error('Client bundle did not register its DSH factory');
  return {id:'yingliu-video-studio',externals:[...externals].sort(),bytes:Buffer.byteLength(source)};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const file=resolve(process.argv[2]||'lib/client.js');
  console.log(JSON.stringify(checkClientBundle(await readFile(file,'utf8'),file)));
}
