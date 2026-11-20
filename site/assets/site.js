document.querySelectorAll("pre").forEach(function(pre){
  var b=document.createElement("button");b.className="copy";b.type="button";b.textContent="Copy";
  b.addEventListener("click",function(){var t=pre.innerText.replace(/\nCopy$/,"");
    (navigator.clipboard?navigator.clipboard.writeText(t):Promise.reject()).then(function(){b.textContent="Copied";setTimeout(function(){b.textContent="Copy"},1400)},function(){b.textContent="Select and copy"})});
  pre.appendChild(b);
});
document.querySelectorAll(".term[data-copy]").forEach(function(el){
  var b=document.createElement("button");b.className="copy";b.type="button";b.textContent="Copy";
  b.addEventListener("click",function(){navigator.clipboard&&navigator.clipboard.writeText(el.getAttribute("data-copy")).then(function(){b.textContent="Copied";setTimeout(function(){b.textContent="Copy"},1400)})});
  el.appendChild(b);
});

document.querySelectorAll("details.nav").forEach(function(d){d.open=!window.matchMedia("(max-width:860px)").matches});
