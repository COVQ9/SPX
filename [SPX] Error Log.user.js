// ==UserScript==
// @name         [SPX] Error Log
// @namespace    http://tampermonkey.net/
// @updateURL    https://raw.githubusercontent.com/COVQ9/SPX/main/%5BSPX%5D%20Error%20Log.user.js
// @downloadURL  https://raw.githubusercontent.com/COVQ9/SPX/main/%5BSPX%5D%20Error%20Log.user.js
// @version      5.30
// @description  Error log footer (optimized but identical UI)
// @match        https://sp.spx.shopee.vn/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
'use strict';

/* ---------------- URL CHECK ---------------- */

function isReceiveTaskPage(){
return location.href.includes("/receive-task/");
}

/* ---------------- STORAGE ---------------- */

const DEFAULT_LOG_VISIBLE=true;
const logStorage=[];
const maxLines=13;
const processedNodes=new WeakSet();

/* ---------------- UI ---------------- */

const footer=document.createElement('div');
Object.assign(footer.style,{
position:'fixed',
bottom:'0',
left:'50%',
transform:'translateX(-50%)',
backgroundColor:'transparent',
borderTop:'1px solid #333',
zIndex:9999,
fontFamily:'monospace',
display:'none',
width:'100%',
maxWidth:'1200px',
boxSizing:'border-box',
padding:'0',
flexDirection:'column',
alignItems:'center'
});
document.body.appendChild(footer);

const logBody=document.createElement('div');
Object.assign(logBody.style,{
backgroundColor:'rgba(255,255,180,0.4)',
display:DEFAULT_LOG_VISIBLE?'flex':'none',
flexDirection:'column',
fontSize:'37px',
lineHeight:'50px',
overflowY:'auto',
maxHeight:'600px',
width:'100%',
padding:'0 6px',
opacity:'1',
transform:'translateY(0)',
transition:'opacity 260ms ease, transform 260ms ease'
});
footer.appendChild(logBody);

const btnBar=document.createElement('div');
Object.assign(btnBar.style,{
display:'flex',
justifyContent:'center',
width:'100%',
background:'#transparent',
padding:'6px 0'
});

const toggleBtn=document.createElement('button');
Object.assign(toggleBtn.style,{
width:'200px',
fontSize:'22px',
margin:'0 8px',
padding:'8px'
});
toggleBtn.textContent=DEFAULT_LOG_VISIBLE?"Hide":"Show";
toggleBtn.setAttribute('tabindex','-1');

const clearBtn=document.createElement('button');
Object.assign(clearBtn.style,{
width:'200px',
fontSize:'22px',
margin:'0 8px',
padding:'8px',
background:'#ffdddd',
display:'none'
});
clearBtn.textContent="Clear";
clearBtn.setAttribute('tabindex','-1');

btnBar.appendChild(toggleBtn);
btnBar.appendChild(clearBtn);
footer.appendChild(btnBar);

let logVisible=DEFAULT_LOG_VISIBLE;

/* ---------------- HELPERS ---------------- */

function escapeHtml(t){
const div=document.createElement('div');
div.textContent=t;
return div.innerHTML;
}

function updateClearButton(){
clearBtn.style.display=(logVisible && logStorage.length>0)?'block':'none';
}

/* ---------------- ANIMATION ---------------- */

function hideLogAnimated(){
logBody.style.opacity='0';
logBody.style.transform='translateY(8px)';
setTimeout(()=>{
if(!logVisible){
logBody.style.display='none';
}
},260);
}

function showLogAnimated(){
logBody.style.display='flex';
requestAnimationFrame(()=>{
logBody.style.opacity='1';
logBody.style.transform='translateY(0)';
});
}

/* ---------------- BUTTONS ---------------- */

toggleBtn.addEventListener('click',()=>{
logVisible=!logVisible;
toggleBtn.textContent=logVisible?"Hide":"Show";
logVisible?showLogAnimated():hideLogAnimated();
updateClearButton();
});

clearBtn.addEventListener('click',()=>{
logStorage.length=0;
updateLog();
});

/* ---------------- LOG RENDER ---------------- */

function updateLog(){

logBody.innerHTML='';

const reversed=logStorage.slice().reverse();

reversed.forEach((v,i)=>{

const line=document.createElement('div');

line.style.lineHeight='50px';
line.style.whiteSpace="nowrap";
line.style.overflow="hidden";
line.style.textOverflow="ellipsis";
line.style.padding='2px 0';

let txt=escapeHtml(v.replace(" - "," → "));
if(i===0) txt+=" 🔥";

const hr=document.createElement('hr');
hr.style.margin='0';
hr.style.border='none';
hr.style.borderTop='1px solid rgba(0,0,0,0.08)';

line.innerHTML=txt;
line.appendChild(hr);

logBody.appendChild(line);

});

updateClearButton();
}

/* ---------------- INPUT CACHE ---------------- */

let cachedInput=null;

function getInput(){

if(cachedInput && document.body.contains(cachedInput))
return cachedInput;

cachedInput=document.querySelector("div.ssc-input input");
return cachedInput;

}

function safeClearInput(){

const input=getInput();
if(!input) return;

input.value="";
input.dispatchEvent(new InputEvent("input",{bubbles:true}));

}

/* ---------------- ERROR PATTERNS ---------------- */

const failurePatterns=[
{pattern:/order is not created status/i,message:"đơn đã hủy"},
{pattern:/too many orders for this receive task/i,message:"vượt quá 500 đơn mỗi phiên"},
{pattern:/please input a valid scan tracking number/i,message:"mã sai định dạng"},
{pattern:/fleetorder not found/i,message:"mã này ko tồn tại"},
{pattern:/already been scanned/i,message:"đơn nằm trong phiên cũ đã kết"},
{pattern:/order exists already/i,message:"trùng với đơn khác cùng phiên"},
{pattern:/order picked up already/i,message:"pick-up đã bắn rồi"}
];

/* ---------------- STATE ---------------- */

let r3TriggeredThisPage=false;

/* ---------------- OBSERVER ---------------- */

const observer=new MutationObserver(muts=>{

for(const m of muts){

for(const node of m.addedNodes){

if(node.nodeType!==1) continue;

/* SUCCESS TOAST */

if(/completed successfully/i.test(node.innerText)){
setTimeout(()=>{
if(logVisible){
logVisible=false;
toggleBtn.textContent="Show";
hideLogAnimated();
updateClearButton();
}
},1500);
}

/* ERROR MESSAGES */

const msgNodes=node.matches('.ssc-message-content,.ssc-message-tutu')
?[node]
:node.querySelectorAll?.('.ssc-message-content,.ssc-message-tutu')||[];

msgNodes.forEach(n=>{

if(processedNodes.has(n)) return;

const msg=n.innerText.trim();

let failMsg=null;

for(const fp of failurePatterns){
if(fp.pattern.test(msg)){
failMsg=fp.message;
break;
}
}

const input=getInput();
const awb=input?(input.value.trim()||"<unknown>"):"<unknown>";

safeClearInput();

if(failMsg){

logStorage.push(`${awb} - ${failMsg}`);

if(logStorage.length>maxLines)logStorage.shift();

if(!logVisible){
logVisible=true;
toggleBtn.textContent="Hide";
showLogAnimated();
}

updateLog();

}

processedNodes.add(n);

});

/* R3 POPUP */

if(node.classList?.contains('r3-popup')){
r3TriggeredThisPage=true;
}

}

/* REMOVED NODES */

for(const node of m.removedNodes){

if(node.nodeType!==1) continue;

if(node.classList?.contains('r3-popup') && isReceiveTaskPage()){

footer.style.display='flex';

logVisible?showLogAnimated():hideLogAnimated();

updateClearButton();

}

}

}

});

observer.observe(document.body,{childList:true,subtree:true});

/* ---------------- SPA NAVIGATION ---------------- */

let lastURL=location.href;

function handleURLChange(){

if(location.href!==lastURL){

lastURL=location.href;

if(!isReceiveTaskPage()){
footer.style.display='none';
r3TriggeredThisPage=false;
}

}

}

["pushState","replaceState"].forEach(fn=>{

const orig=history[fn];

history[fn]=function(...args){

const out=orig.apply(this,args);

setTimeout(handleURLChange,120);

return out;

};

});

window.addEventListener('popstate',handleURLChange);

/* ---------------- INIT ---------------- */

updateLog();

})();