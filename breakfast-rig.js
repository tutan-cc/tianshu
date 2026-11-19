/* Student portrait rig: two parented bones, weighted Canvas triangle skinning.
   No dependencies or replacement artwork. Coordinates are normalized to the PNG. */
(function (root) {
  "use strict";
  var COLS = 6, ROWS = 16;
  function smooth(a, b, v) {
    var t = Math.max(0, Math.min(1, (v - a) / (b - a)));
    return t * t * (3 - 2 * t);
  }
  function pose(time, mood, sinceFood, reduced) {
    if (reduced) return { body:0, breath:0, head:0, nod:0 };
    var t = Math.max(0, Number(time) || 0);
    var receipt = sinceFood >= 0 && sinceFood < 1.1
      ? Math.sin(Math.PI * sinceFood / 1.1) * Math.sin(Math.PI * sinceFood / 1.1) : 0;
    var urgent = mood === "urgent" ? 1 : 0;
    return {
      body: Math.sin(t * 1.6) * 0.006,
      breath: Math.sin(t * 2.0) * 0.009,
      head: Math.sin(t * 1.15) * 0.018 + urgent * Math.sin(t * 5.0) * 0.027 + receipt * 0.055,
      nod: receipt
    };
  }
  function rotate(x, y, px, py, angle) {
    var c = Math.cos(angle), s = Math.sin(angle);
    return { x:px + (x-px)*c - (y-py)*s, y:py + (x-px)*s + (y-py)*c };
  }
  function deform(x, y, p) {
    // Head is rigid above the jaw; only the neck blends the two bone influences.
    var weight = 1 - smooth(0.58, 0.77, y);
    var h = rotate(x, 0.63 + (y-0.63)*(1-p.nod*0.045), 0.50, 0.63, p.head);
    x += (h.x-x)*weight;
    y += (h.y + p.nod*0.014-y)*weight;
    y = 0.98 + (y-0.98)*(1+p.breath);
    return rotate(x, y, 0.50, 0.98, p.body);
  }
  var vertices = [], triangles = [];
  for (var row=0; row<=ROWS; row++) for (var col=0; col<=COLS; col++) {
    vertices.push({x:col/COLS, y:row/ROWS});
  }
  for (row=0; row<ROWS; row++) for (col=0; col<COLS; col++) {
    var a=row*(COLS+1)+col, b=a+1, c=a+COLS+1, d=c+1;
    triangles.push([a,b,d], [a,d,c]);
  }
  function triangle(g, img, src, dst) {
    var a=src[0], b=src[1], c=src[2], u=dst[0], v=dst[1], w=dst[2];
    var det=(b.x-a.x)*(c.y-a.y)-(c.x-a.x)*(b.y-a.y);
    var A=((v.x-u.x)*(c.y-a.y)-(w.x-u.x)*(b.y-a.y))/det;
    var B=((v.y-u.y)*(c.y-a.y)-(w.y-u.y)*(b.y-a.y))/det;
    var C=((w.x-u.x)*(b.x-a.x)-(v.x-u.x)*(c.x-a.x))/det;
    var D=((w.y-u.y)*(b.x-a.x)-(v.y-u.y)*(c.x-a.x))/det;
    var cx=(u.x+v.x+w.x)/3, cy=(u.y+v.y+w.y)/3;
    g.save(); g.beginPath();
    // A small clip overlap prevents antialiased cracks between adjacent triangles.
    for (var k=0; k<3; k++) {
      var q=dst[k], dx=q.x-cx, dy=q.y-cy, len=Math.sqrt(dx*dx+dy*dy)||1;
      var x=q.x+dx/len*0.32, y=q.y+dy/len*0.32;
      if (!k) g.moveTo(x,y); else g.lineTo(x,y);
    }
    g.closePath(); g.clip();
    g.transform(A,B,C,D,u.x-A*a.x-C*a.y,u.y-B*a.x-D*a.y);
    g.drawImage(img,0,0); g.restore();
  }
  function draw(g, img, box, options) {
    options=options||{};
    var iw=img && img.naturalWidth, ih=img && img.naturalHeight;
    if (!(iw>0 && ih>0)) return false;
    var scale=Math.min(box.w/iw,box.h/ih), width=iw*scale, height=ih*scale;
    var left=box.x+(box.w-width)/2, top=box.y+(box.h-height)/2;
    var p=pose(options.time, options.mood, options.sinceFood, options.reduced);
    var points=vertices.map(function(v) {
      var q=deform(v.x,v.y,p);
      return {x:left+q.x*width,y:top+q.y*height};
    });
    g.save();
    if (options.reduced) g.drawImage(img,left,top,width,height);
    else triangles.forEach(function(ids) {
      triangle(g,img,ids.map(function(i){return {x:vertices[i].x*iw,y:vertices[i].y*ih};}),
        ids.map(function(i){return points[i];}));
    });
    if (options.mesh) {
      g.strokeStyle="rgba(255,220,131,.30)"; g.lineWidth=0.7;
      triangles.forEach(function(ids) {
        g.beginPath(); ids.forEach(function(i,k){var q=points[i]; if(k)g.lineTo(q.x,q.y);else g.moveTo(q.x,q.y);});
        g.closePath(); g.stroke();
      });
    }
    if (options.bones) {
      var joints=[[0.5,0.98],[0.5,0.67],[0.5,0.35]].map(function(v){
        var q=deform(v[0],v[1],p);return {x:left+q.x*width,y:top+q.y*height};
      });
      g.strokeStyle="#64eed0"; g.fillStyle="#fff4ca"; g.lineWidth=3;
      g.beginPath();g.moveTo(joints[0].x,joints[0].y);g.lineTo(joints[1].x,joints[1].y);g.lineTo(joints[2].x,joints[2].y);g.stroke();
      joints.forEach(function(q){g.beginPath();g.arc(q.x,q.y,4,0,Math.PI*2);g.fill();});
    }
    g.restore(); return true;
  }
  root.BreakfastRig={draw:draw, pose:pose, deform:deform, bones:["body","head"], vertexCount:vertices.length};
})(typeof window!=="undefined"?window:globalThis);
