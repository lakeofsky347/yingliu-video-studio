import {build} from 'tsdown';
import {readFile,writeFile,mkdir,cp} from 'node:fs/promises';
import {checkClientBundle} from './check-client-bundle.mjs';
const css=await readFile('src/client/styles.css','utf8');
const graphCss=await readFile('node_modules/@comfyorg/litegraph/dist/css/litegraph.css','utf8');
await build({entry:{index:'src/host/index.ts'},format:'esm',platform:'node',outDir:'lib',clean:true,dts:false,sourcemap:false,deps:{neverBundle:['playwright-core','@deepseek-ai/dsh-tools','@deepseek-ai/dsh-client-connection']},outputOptions:{entryFileNames:'[name].js',chunkFileNames:'chunk-[hash].js'}});
await build({entry:{client:'src/client/index.tsx'},format:'cjs',platform:'browser',outDir:'lib',clean:false,dts:false,sourcemap:false,
  // tsdown 0.22 uses Node resolution for CJS unless the underlying input platform is overridden.
  inputOptions:{platform:'browser'},
  // DSH provides React seeds, but does not resolve ordinary npm packages in its browser module table.
  deps:{neverBundle:['react','react/jsx-runtime'],alwaysBundle:['@comfyorg/litegraph','fflate'],onlyBundle:['@comfyorg/litegraph','fflate']},
  plugins:[{name:'studio-css',resolveId(source){if(source.endsWith('.css?inline'))return '\0studio-css';},load(id){if(id==='\0studio-css')return `export default ${JSON.stringify(graphCss+'\n'+css)};`;}}],
  outputOptions:{entryFileNames:'client.js',banner:'window.__ModuleLoader__.load({id:"yingliu-video-studio",factory:(require)=>{',intro:'var module={exports:{}}; var exports=module.exports;',footer:'return module.exports;}});'}});
const client=checkClientBundle(await readFile('lib/client.js','utf8'),'lib/client.js');
console.log(`Client factory verified; external modules: ${client.externals.join(', ')}`);
await mkdir('lib/licenses',{recursive:true});await cp('licenses','lib/licenses',{recursive:true});
await writeFile('lib/styles.css',css);
