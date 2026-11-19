// Real Chrome check of preview controls, canvas deformation and game integration.
const http=require('node:http'),fs=require('node:fs'),path=require('node:path');
const {spawn}=require('node:child_process');
const assert=require('node:assert/strict');
const MODEORIGINAL=process.argv.includes('--original'),MODE3D=process.argv.includes('--3d')||MODEORIGINAL;
const ROOT=path.resolve(__dirname,'../..'),OUT=path.join(ROOT,'dist',MODEORIGINAL?'breakfast-original':MODE3D?'breakfast-3d':'breakfast-rig');
fs.mkdirSync(OUT,{recursive:true});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let ws,chrome,server,seq=0;const pending=new Map(),errors=[];
function send(method,params={}){return new Promise((resolve,reject)=>{
  const id=++seq,timeout=setTimeout(()=>{pending.delete(id);reject(Error(method+' timeout'));},15000);
  pending.set(id,{resolve,reject,timeout});ws.send(JSON.stringify({id,method,params}));
});}
async function evaluate(expression){const r=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
  if(r.error)throw Error(JSON.stringify(r.error));if(r.result.exceptionDetails)throw Error(JSON.stringify(r.result.exceptionDetails));
  return r.result.result.value;}
async function ready(expression){for(let i=0;i<100;i++){if(await evaluate(expression))return;await sleep(100);}throw Error('not ready: '+expression);}
async function shot(name){const r=await send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(OUT,name+'.png'),Buffer.from(r.result.data,'base64'));}
(async()=>{try{
  const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.png':'image/png','.mp3':'audio/mpeg'};
  server=http.createServer((req,res)=>{const requested=decodeURIComponent(req.url.split('?')[0]);
    // Serve ONLY the HTML at this nested URL: relative JS/PNG requests would 404.
    const file=requested==='/isolated/preview.html'?path.join(ROOT,MODEORIGINAL?'早餐人物-原画立体预览.html':MODE3D?'早餐人物3D-独立预览.html':'breakfast-rig-preview.html'):path.resolve(ROOT,'.'+requested);
    if(!file.startsWith(ROOT+path.sep)){res.writeHead(403).end();return;}
    fs.readFile(file,(e,b)=>{if(e){res.writeHead(404).end();return;}res.setHeader('Content-Type',mime[path.extname(file)]||'application/octet-stream');res.end(b);});});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
  chrome=spawn(process.env.CHROME_PATH||'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',[
    '--headless=new','--remote-debugging-port=0','--window-size=1280,1000','--no-first-run','--enable-unsafe-swiftshader',
    '--user-data-dir='+path.join(OUT,'chrome-profile'),'about:blank'],{stdio:['ignore','ignore','pipe'],windowsHide:true});
  const browserUrl=await new Promise((resolve,reject)=>{let s='';const timer=setTimeout(()=>reject(Error('Chrome startup timeout')),15000);
    chrome.stderr.on('data',b=>{s+=b;const m=s.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(m){clearTimeout(timer);resolve(m[1]);}});chrome.on('error',reject);});
  const origin='http://'+new URL(browserUrl).host;
  const targets=await (await fetch(origin+'/json/list')).json();
  ws=new WebSocket(targets.find(t=>t.type==='page').webSocketDebuggerUrl);
  await new Promise(r=>ws.addEventListener('open',r,{once:true}));
  ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id&&pending.has(m.id)){const p=pending.get(m.id);clearTimeout(p.timeout);pending.delete(m.id);p.resolve(m);}
    if(m.method==='Runtime.exceptionThrown')errors.push(m.params.exceptionDetails.text+': '+(m.params.exceptionDetails.exception?.description||''));});
  await send('Runtime.enable');await send('Page.enable');
  await send('Page.navigate',{url:base+'/isolated/preview.html'});
  if(MODE3D){
    const preview=MODEORIGINAL?'OriginalStudentPreview':'Student3DPreview';
    await ready('!!window.'+preview);await sleep(600);
    assert.ok(await evaluate(preview+'.state().boneCount>='+ (MODEORIGINAL?8:35)));
    if(MODEORIGINAL){
      assert.ok(await evaluate('OriginalStudentPreview.character.portraitMesh.material.map.image===OriginalStudentPreview.images.calm'));
      await shot('static-composition');
      await evaluate("document.querySelector('[data-action=receive]').click()");await sleep(1200);
    }
    await evaluate("document.getElementById('pause').checked=true");await sleep(150);await shot('receive');
    await evaluate("document.querySelector('[data-action=wave]').click()");await sleep(1500);
    await evaluate("document.getElementById('pause').checked=true");await sleep(100);await shot('wave');
    const stageClip=await evaluate('(()=>{const r=document.getElementById("stage").getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,scale:1};})()');
    const thumbnail=await send('Page.captureScreenshot',{format:'png',clip:stageClip});fs.writeFileSync(path.join(OUT,'character.png'),Buffer.from(thumbnail.result.data,'base64'));
    if(MODEORIGINAL){
      await evaluate("document.getElementById('compare').click()");await sleep(100);await shot('original-reference');
      assert.ok(await evaluate('OriginalStudentPreview.state().comparing'));
      await evaluate("document.getElementById('compare').click();document.getElementById('bones').click()");
    }else{
      await evaluate("document.querySelector('[data-view=side]').click()");await sleep(100);await shot('side');
      await evaluate("document.querySelector('[data-view=back]').click()");await sleep(100);await shot('back');
      await evaluate("document.querySelector('[data-view=front]').click();document.getElementById('bones').click()");
    }
    await sleep(100);await shot('bones');
    const size=await evaluate(preview+'.renderer.info.render.triangles');assert.ok(size>1000);
    await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await sleep(250);
    assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false);await shot('mobile');
    await send('Emulation.clearDeviceMetricsOverride');
    await send('Page.navigate',{url:base+'/index.html'});await ready('!!window.Breakfast && !!window.Breakfast3D');
    await evaluate(`(()=>{document.getElementById('title').style.display='none';document.getElementById('bfGame').classList.add('on');
      window.student3dEvents=[];const original=Breakfast3D.draw;Breakfast3D.draw=function(g,img,box,opts){
        const result=original(g,img,box,opts);if(student3dEvents.length>200)student3dEvents.shift();student3dEvents.push({ok:result,mood:opts.mood,sinceFood:opts.sinceFood,reduced:opts.reduced});return result;};
      Breakfast.start(document.getElementById('bfGameHost'),{duration:120,goal:99,practice:true});
      window.studentId=Breakfast.debug.pushCustomer(['egg','milk']);})()`);
    await ready('student3dEvents.some(e=>e.ok)');await shot('game-3d');
    await evaluate("Breakfast.debug.tap('bucket','egg');Breakfast.debug.tick(2.3);Breakfast.debug.takeOut(Breakfast.columnOf('egg'));Breakfast.debug.serveId(studentId)");
    await ready('student3dEvents.some(e=>e.ok && e.sinceFood>=0)');
    await evaluate("Breakfast.debug.tap('bucket','milk');Breakfast.debug.tick(2.1);Breakfast.debug.takeOut(Breakfast.columnOf('milk'));Breakfast.debug.serveId(studentId)");
    await ready("student3dEvents.some(e=>e.ok && e.mood==='happy')");await shot('game-3d-receipt');
    assert.equal(await evaluate('Breakfast.debug.state().served'),1);
    await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
    await evaluate('Breakfast.dispose();student3dEvents=[];Breakfast.start(document.getElementById("bfGameHost"),{practice:true});Breakfast.debug.pushCustomer(["egg"])');
    await ready('student3dEvents.some(e=>e.ok)');assert.ok(await evaluate('student3dEvents.every(e=>e.reduced===true)'));
    // Explicitly disable 3D to verify the existing 2D fallback remains playable.
    await evaluate('Breakfast.dispose();Breakfast3D.draw=function(){return false;};Breakfast.start(document.getElementById("bfGameHost"),{practice:true});Breakfast.debug.pushCustomer(["egg"])');
    await ready('Breakfast.debug.view().drawn.rigFaces>0');
    console.log(JSON.stringify({mode:MODEORIGINAL?'original-relief':'3d',triangles:size,gameReceipt:true,reducedMotion:true,fallback2D:true,errors,screenshots:OUT}));assert.deepEqual(errors,[]);return;
  }
  await ready("document.getElementById('status')?.textContent.includes('已就绪')");
  await evaluate("document.getElementById('pause').checked=true");
  await sleep(100);await shot('preview');
  const diff=await evaluate(`(()=>{const img=new Image();img.src='/art/icons/faces/stud_calm.png';return img.decode().then(()=>{
    const c=document.createElement('canvas');c.width=400;c.height=400;const g=c.getContext('2d');const box={x:40,y:20,w:320,h:350};
    BreakfastRig.draw(g,img,box,{time:0,mood:'calm',sinceFood:-1});const a=g.getImageData(0,0,400,400).data;
    g.clearRect(0,0,400,400);BreakfastRig.draw(g,img,box,{time:0,mood:'happy',sinceFood:.55});const b=g.getImageData(0,0,400,400).data;
    let n=0;for(let i=0;i<a.length;i+=4)if(Math.abs(a[i]-b[i])+Math.abs(a[i+1]-b[i+1])>20)n++;return n;});})()`);
  assert.ok(diff>1000,'nod should visibly change pixels');
  await evaluate("document.getElementById('bones').click();document.getElementById('mesh').click()");await sleep(100);await shot('bones');
  await evaluate("document.querySelector('[data-mood=urgent]').click()");await sleep(100);
  assert.match(await evaluate("document.getElementById('caption').textContent"),/着急/);
  await evaluate("document.getElementById('serve').click()");await sleep(500);
  assert.match(await evaluate("document.getElementById('caption').textContent"),/满意/);await shot('nod');
  await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});await sleep(200);
  assert.equal(await evaluate('document.documentElement.scrollWidth>innerWidth'),false);await shot('mobile');
  await send('Emulation.clearDeviceMetricsOverride');
  await send('Page.navigate',{url:base+'/index.html'});
  await ready('!!window.Breakfast && !!window.BreakfastRig');
  await evaluate('window.Breakfast3D=undefined'); // Exercise the 2D compatibility path.
  await evaluate(`(()=>{document.getElementById('title').classList.add('hide');document.getElementById('bfGame').classList.add('on');
    Breakfast.start(document.getElementById('bfGameHost'),{duration:120,goal:99,practice:true});
    window.rigEvents=[];const original=BreakfastRig.draw;BreakfastRig.draw=function(g,img,box,opts){
      if(rigEvents.length>500)rigEvents.shift();rigEvents.push({mood:opts.mood,sinceFood:opts.sinceFood,reduced:opts.reduced});return original(g,img,box,opts);};
    window.studentId=Breakfast.debug.pushCustomer(['egg','milk']);return true;})()`);
  await ready('Breakfast.debug.faces().some(f=>f.ready)');
  await ready('rigEvents.length>0');await shot('game');
  assert.ok(await evaluate("Breakfast.debug.faces().find(f=>f.id===studentId).name.startsWith('stud_')"));
  await evaluate("Breakfast.debug.tap('bucket','egg');Breakfast.debug.tick(2.3);Breakfast.debug.takeOut(Breakfast.columnOf('egg'));Breakfast.debug.serveId(studentId)");
  await ready('rigEvents.some(e=>e.sinceFood>=0 && e.sinceFood<1.1)');
  await evaluate("Breakfast.debug.tap('bucket','milk');Breakfast.debug.tick(2.1);Breakfast.debug.takeOut(Breakfast.columnOf('milk'));Breakfast.debug.serveId(studentId)");
  await ready("rigEvents.some(e=>e.mood==='happy')");await shot('game-receipt');
  assert.equal(await evaluate('Breakfast.debug.state().served'),1);
  await send('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await evaluate('Breakfast.dispose();window.rigEvents=[];Breakfast.start(document.getElementById("bfGameHost"),{practice:true});Breakfast.debug.pushCustomer(["egg"])');
  await ready('rigEvents.length>0');
  const reduced=await evaluate("matchMedia('(prefers-reduced-motion: reduce)').matches && rigEvents.every(e=>e.reduced===true)");assert.ok(reduced);
  console.log(JSON.stringify({pixelDifference:diff,errors,screenshots:OUT}));
  assert.deepEqual(errors,[]);
}finally{if(ws)ws.close();if(chrome)chrome.kill();if(server)server.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
