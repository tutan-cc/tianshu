const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..');
const embed=file=>fs.readFileSync(path.join(root,file),'utf8').replace(/<\/script/gi,'<\\/script');
const source=fs.readFileSync(path.join(__dirname,'3d-preview.template.html'),'utf8');
const html=source.replace('/*THREE_BUNDLE*/',()=>embed('three.min.js')).replace('/*CHARACTER_BUNDLE*/',()=>embed('breakfast-character3d.js'));
const output=path.join(root,'早餐人物3D-独立预览.html');
fs.writeFileSync(output,html,'utf8');
console.log('3D standalone preview:',Buffer.byteLength(html),'bytes');
