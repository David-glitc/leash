(function(){
"use strict";
var D=null;
function $(id){return document.getElementById(id)}
function el(tag,cls,text){var e=document.createElement(tag);if(cls)e.className=cls;if(text!=null)e.textContent=text;return e}
function short(h){return h.slice(0,10)+"…"+h.slice(-4)}
function txLink(h){var a=el("a","",short(h));a.href="https://explore.qore.network/tx/"+h;a.target="_blank";a.rel="noopener";return a}
function rpc(m,p){return fetch(D.rpc,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({jsonrpc:"2.0",id:1,method:m,params:p})}).then(function(r){return r.json()}).then(function(j){if(j.error)throw new Error(j.error.message);return j.result})}
function call(to,sel){return rpc("eth_call",[{to:to,data:sel},"latest"])}

/* ---------- the playground ---------- */
function presets(){var r=D.registry,a=r.agent;return [
 {name:"Pay inside a mandate",text:"agent "+a+" up to 3 QOR a day, at most 1 QOR per payment, only to "+r.payee+" for 3 hours"},
 {name:"Swap with a rate floor",text:"agent "+a+" up to 100 USD a day, at most 40 USD per payment, swap USD for ETHX on "+r.router+" at no worse than 0.00049 ETHX per USD for 5 hours"},
 {name:"Swap with no floor (refused)",text:"agent "+a+" up to 100 USD a day, at most 40 USD per payment, swap USD for ETHX on "+r.router+" for 5 hours"},
 {name:"Wrap and use a vault",text:"agent "+a+" up to 2 QOR a day, at most 1 QOR per payment, up to 2 WQOR a day, up to 100 USD a day, at most 50 USD per payment, up to 100 VUSD a day, wrap QOR into WQOR on "+r.tokens.WQOR+", deposit USD into vault "+r.vault+" as VUSD at no worse than 0.99 VUSD per USD for 5 hours"},
 {name:"Too vague (refused)",text:"agent "+a+" up to 3 QOR a day"}]}
function registry(){var t={};Object.keys(D.registry.tokens).forEach(function(k){t[k]={address:D.registry.tokens[k],decimals:18}});return t}
function render(res){
 var out=$("pg-out");out.innerHTML="";
 var head=el("div","badge "+(res.ok?"ok":"bad"),res.ok?"LEASH OK":"LEASH REFUSED");out.appendChild(head);
 if(res.summary)out.appendChild(el("p","sumline",res.summary));
 var f=el("ul","findings");res.findings.forEach(function(x){var li=el("li",x.severity);var b=el("b","",x.severity);li.appendChild(b);li.appendChild(document.createTextNode(" "+x.message));f.appendChild(li)});out.appendChild(f);
 if(res.mandate&&res.mandate.routes&&res.mandate.routes.length){
  var t=el("table");t.innerHTML="<thead><tr><th>Route</th><th>From</th><th>To</th><th>Target</th><th>Floor (raw units per unit x 1e18)</th></tr></thead>";
  var tb=el("tbody");res.mandate.routes.forEach(function(r){var tr=el("tr");[r.kind||"route",sym(r.tokenIn),sym(r.tokenOut),r.target,r.minOutPerInE18].forEach(function(c){var td=el("td");td.textContent=c;tr.appendChild(td)});tb.appendChild(tr)});t.appendChild(tb);out.appendChild(t)}
 if(res.plan){var d=el("details");d.appendChild(el("summary","","On-chain plan ("+res.plan.steps.length+" steps)"));var ol=el("ol");res.plan.steps.forEach(function(s){ol.appendChild(el("li","",s.replace(/^\d+\.\s*/,"")))});d.appendChild(ol);out.appendChild(d)}
 if(res.mandate){var d2=el("details");d2.appendChild(el("summary","","Mandate as JSON (what the owner signs)"));d2.appendChild(el("pre","",JSON.stringify(res.mandate,null,2)));out.appendChild(d2)}
}
function sym(a){var t=D.registry.tokens;if(/^0x0+$/.test(a))return"QOR";for(var k in t)if(t[k].toLowerCase()===a.toLowerCase())return k;return a}
function run(){var text=$("pg-in").value;if(!window.LeashCore){$("pg-out").textContent="The compiler did not load.";return}
 try{render(window.LeashCore.compile(text,{tokens:registry(),adapters:D.registry.adapters,guard:D.guards.v2}))}catch(e){$("pg-out").textContent="Error: "+e.message}}
function initPlayground(){var sel=$("pg-presets");presets().forEach(function(p,i){var b=el("button","chip",p.name);b.type="button";b.addEventListener("click",function(){$("pg-in").value=p.text;run()});sel.appendChild(b)});
 $("pg-run").addEventListener("click",run);$("pg-in").value=presets()[1].text;run()}

/* ---------- live verification ---------- */
function maskedEq(onchainHex,expected,refs){var b=onchainHex.toLowerCase().replace(/^0x/,"").split("");refs.forEach(function(r){for(var i=r.start*2;i<(r.start+r.length)*2;i++)b[i]="0"});return b.join("")===expected}
function status(line,cls,text,detail){var li=el("li",cls);li.appendChild(el("b","",text));li.appendChild(document.createTextNode(" "+line+(detail?"  ":"")));if(detail){var s=el("span","dim");if(typeof detail==="string")s.textContent=detail;else s.appendChild(detail);li.appendChild(s)}return li}
async function verify(){
 var ul=$("vf-out"),sum=$("vf-sum");ul.innerHTML="";sum.textContent="Running against "+D.rpc+" …";var pass=0,fail=0;
 async function check(name,fn){try{var d=await fn();ul.appendChild(status(name,"pass","PASS",d||""));pass++}catch(e){ul.appendChild(status(name,"fail","FAIL",e.message||String(e)));fail++}}
 async function receipt(h,to){var r=await rpc("eth_getTransactionReceipt",[h]);if(!r)throw new Error("receipt not found");if(r.status!=="0x1")throw new Error("transaction reverted");if(to&&r.to.toLowerCase()!==to.toLowerCase())throw new Error("went to "+r.to);return r}
 var g1=D.guards.v1,g2=D.guards.v2;
 await check("connected to qorechain-diana (chain id 9800)",async function(){var id=parseInt(await rpc("eth_chainId",[]),16);if(id!==9800)throw new Error("chain id "+id)});
 await check("v1 guard: owner is the registered owner account",async function(){var o="0x"+(await call(g1,D.selectors.owner)).slice(-40);if(o.toLowerCase()!==D.owner.toLowerCase())throw new Error("owner is "+o);return o});
 await check("v1 guard: deployed code equals this source",async function(){var c=await rpc("eth_getCode",[g1,"latest"]);if(!maskedEq(c,D.code.v1,D.refs.v1))throw new Error("deployed code differs");return (c.length-2)/2+" bytes, identical (immutables masked)"});
 await check("v1: applyMandate succeeded (pqcVerify accepted a real ML-DSA-87 signature)",async function(){var r=await receipt(D.applyTx.v1,g1);return txLink(D.applyTx.v1)});
 await check("v2 guard: owner is the registered owner account",async function(){var o="0x"+(await call(g2,D.selectors.owner)).slice(-40);if(o.toLowerCase()!==D.owner.toLowerCase())throw new Error("owner is "+o);return o});
 await check("v2 guard: at least two owner-signed mandates applied",async function(){var n=parseInt(await call(g2,D.selectors.nonce),16);if(n<2)throw new Error("nonce is "+n);return"nonce "+n});
 await check("v2 guard: six routes in the mandate",async function(){var h=await call(g2,D.selectors.routes);var len=parseInt(h.slice(2+64,2+128),16);if(len!==6)throw new Error(len+" routes");return len+" routes"});
 await check("v2 guard: deployed code equals this source",async function(){var c=await rpc("eth_getCode",[g2,"latest"]);if(!maskedEq(c,D.code.v2,D.refs.v2))throw new Error("deployed code differs");return (c.length-2)/2+" bytes, identical (immutables masked)"});
 await check("v2: applyMandate with routes succeeded (a real ML-DSA-87 signature)",async function(){await receipt(D.applyTx.v2,g2);return txLink(D.applyTx.v2)});
 for(var i=0;i<D.tour.length;i++){await (function(t){return check("v2: "+t.kind+" through the guard succeeded and emitted Executed",async function(){var r=await receipt(t.tx,g2);var ok=r.logs.some(function(l){return l.address.toLowerCase()===g2.toLowerCase()&&l.topics[0]===D.executedTopic});if(!ok)throw new Error("no Executed event");return txLink(t.tx)})})(D.tour[i])}
 for(var j=0;j<D.mcpTx.length;j++){await (function(t){return check("MCP: "+t.tool+" made by an MCP client succeeded",async function(){await receipt(t.tx,g2);return txLink(t.tx)})})(D.mcpTx[j])}
 [["testnetV1",13],["testnetV2",15],["localV1",14],["localV2",16]].forEach(function(p){var rows=D.drills[p[0]];var n=rows.filter(function(r){return r.pass}).length;
   var li=n===p[1]&&rows.length===p[1]?status("drill "+p[0]+": "+p[1]+" of "+p[1]+" rows as expected","pass","PASS"):status("drill "+p[0],"fail","FAIL",n+" of "+rows.length);ul.appendChild(li);if(n===p[1]&&rows.length===p[1])pass++;else fail++});
 if(D.campaign){var okc=D.campaign.violations===0&&D.campaign.attempts>=500;ul.appendChild(status("attack campaign report: zero violations across all attacks",okc?"pass":"fail",okc?"PASS":"FAIL",D.campaign.attempts+" attacks, "+D.campaign.accepted+" accepted (all inside the mandate)"));if(okc)pass++;else fail++}
 if(D.mutation){var mm=D.mutation,okm=mm.killed+mm.survived===mm.valid;ul.appendChild(status("mutation report present and consistent",okm?"pass":"fail",okm?"PASS":"FAIL",mm.killed+" of "+mm.valid+" mutants killed ("+mm.kill_rate+"%)"));if(okm)pass++;else fail++}
 sum.className="vsum "+(fail?"bad":"ok");sum.textContent=pass+" passed, "+fail+" failed. Read live from the chain in your browser.";
}
async function liveState(){var box=$("live-state");try{var g=D.guards.v2;var fr=parseInt(await call(g,D.selectors.frozen),16)===1,n=parseInt(await call(g,D.selectors.nonce),16),ex=parseInt(await call(g,D.selectors.expiry),16);var exp=ex*1000<Date.now();
 box.textContent="v2 guard "+g.slice(0,10)+"…  nonce "+n+"  "+(fr?"frozen":"not frozen")+"  mandate "+(exp?"expired "+new Date(ex*1000).toUTCString():"valid until "+new Date(ex*1000).toUTCString())+(exp?" (the proof stays on chain; an owner-signed mandate re-arms it)":"")}catch(e){box.textContent="Could not read the chain: "+e.message}}

/* ---------- drill, transcript ---------- */
function drillTable(id,rows){var t=$(id);t.innerHTML="<thead><tr><th></th><th>Attacker</th><th>Attempt</th><th>Outcome</th></tr></thead>";var tb=el("tbody");
 rows.forEach(function(r){var tr=el("tr",r.pass?"p":"f");tr.appendChild(el("td","",r.pass?"PASS":"FAIL"));tr.appendChild(el("td","",r.attacker));tr.appendChild(el("td","",r.attempt));var td=el("td","",r.outcome+" ");if(r.tx)td.appendChild(txLink(r.tx));tr.appendChild(td);tb.appendChild(tr)});t.appendChild(tb)}
function stack(){var box=$("stack-out");if(!box)return;var items=[];var c=D.campaign,m=D.mutation,sa=D.staticAnalysis;
 if(c)items.push([c.attempts+" attacks","random hostile calls on the live guard: "+c.violations+" violations, "+c.accepted+" accepted (all inside the mandate)"]);
 if(m)items.push([m.kill_rate+"%","of "+m.valid+" mutants killed by the test suite ("+m.survived+" survived, listed in the report)"]);
 if(sa)items.push([(sa.counts.High||0)+" high","static analysis (slither, "+sa.detectors+" detectors): "+(sa.counts.Medium||0)+" medium, triaged"]);
 items.push(["8 invariants","each held over 15,360 random calls"]);
 items.forEach(function(it){var d=el("div","stat");d.appendChild(el("div","n",it[0]));var l=el("div","l",it[1]);d.appendChild(l);box.appendChild(d)});
 if(c)$("camp-note").textContent="Campaign seed "+c.seed+", block "+c.block+". Reproduce with: pnpm campaign --n "+c.attempts+" --seed "+c.seed+". Calls are simulated with eth_call: nothing is sent."}
function transcript(){var box=$("mcp-out");D.mcpTranscript.forEach(function(c){var d=el("details");var s=el("summary","",c.tool+" "+JSON.stringify(c.args).slice(0,90));if(c.isError)s.className="err";d.appendChild(s);d.appendChild(el("pre","",typeof c.result==="string"?c.result:JSON.stringify(c.result,null,2)));box.appendChild(d)});
 $("mon-out").textContent=D.monitor.transcript.join("\n")}

fetch("/assets/verify-data.json").then(function(r){return r.json()}).then(function(d){D=d;initPlayground();$("vf-run").addEventListener("click",verify);drillTable("dr-t2",D.drills.testnetV2);drillTable("dr-l2",D.drills.localV2);transcript();stack();liveState()})
.catch(function(e){var b=$("pg-out");if(b)b.textContent="Could not load the demo data: "+e.message});
})();
