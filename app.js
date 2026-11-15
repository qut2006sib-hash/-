"use strict";
/*
 * Independent reconstruction of our ChatGPT design.
 * The original site's JS/CSS source was unavailable. Local DEMO ONLY.
 */
(function(){
  const KEY="sarvisna_ours_demo_v1";
  const destinations=["","وسط حمص","منطقة السوق","منطقة الحديقة","الوعر الجديد","وجهة خارج الخط التجريبي"];
  const stops=["دوار الوعر","محطة الحديقة","الوعر الجديد","المدخل الغربي","دوار المدينة","وسط حمص"];
  const buses=[
    {id:"b1",name:"سرفيس ١",driver:"أبو خالد",seats:14},
    {id:"b2",name:"سرفيس ٢",driver:"أبو سامر",seats:14},
    {id:"b3",name:"سرفيس ٣",driver:"محمود",seats:7}
  ];
  const labels={pending:"بانتظار سائق",accepted:"قبله السائق",rider_confirmed:"الراكب أكد الركوب",boarded:"تم تأكيد الركوب",completed:"مكتمل",cancelled:"ملغى"};
  const initial=()=>({role:"rider",origin:"",location:false,destination:"",stop:stops[0],bus:"b1",requests:[],notice:""});
  let state=initial();
  try{
    const stored=JSON.parse(localStorage.getItem(KEY));
    if(stored&&typeof stored==="object"&&Array.isArray(stored.requests)){
      state=Object.assign(initial(),stored,{requests:stored.requests.slice(0,50)});
    }
  }catch(e){}
  const root=document.getElementById("app");
  const esc=s=>String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const bus=id=>buses.find(b=>b.id===id);
  const active=r=>!["cancelled","completed"].includes(r.status);
  const filled=id=>state.requests.filter(r=>r.busId===id&&["accepted","rider_confirmed","boarded"].includes(r.status)).length;
  const fmt=n=>new Intl.NumberFormat("ar-SY").format(n);
  function persist(){try{localStorage.setItem(KEY,JSON.stringify(state));}catch(e){}}
  function btn(label,action,id,alt,disabled){
    return '<button type="button" class="btn'+(alt?' alt':'')+'" data-action="'+action+'"'+(id?' data-id="'+esc(id)+'"':'')+(disabled?' disabled':'')+'>'+label+'</button>';
  }
  function mapView(){
    return '<div class="map"><svg viewBox="0 0 760 330" role="img" aria-label="خريطة غير ملاحية للوعر ووسط حمص">'+
      '<rect width="760" height="330" fill="#e9f1e9"/>'+
      '<path d="M0 90 Q240 15 400 80 T760 65 M0 285 Q300 220 760 285" fill="none" stroke="#d1e2d6" stroke-width="28"/>'+
      '<path d="M65 264 C160 260 190 210 298 215 S460 145 550 150 S655 98 705 91" fill="none" stroke="#93c9a5" stroke-width="15" stroke-linecap="round"/>'+
      '<path d="M65 264 C160 260 190 210 298 215 S460 145 550 150 S655 98 705 91" fill="none" stroke="#0f7b63" stroke-width="6" stroke-linecap="round" stroke-dasharray="13 10"/>'+
      '<g fill="#fff" stroke="#147866" stroke-width="5"><circle cx="65" cy="264" r="10"/><circle cx="178" cy="237" r="10"/><circle cx="298" cy="215" r="10"/><circle cx="419" cy="175" r="10"/><circle cx="550" cy="150" r="10"/><circle cx="705" cy="91" r="10"/></g>'+
      '<g fill="#d9a344" stroke="white" stroke-width="4"><rect x="213" y="178" width="27" height="23" rx="7"/><rect x="472" y="118" width="27" height="23" rx="7"/><rect x="622" y="103" width="27" height="23" rx="7"/></g>'+
      '<g font-family="Tahoma,Arial" font-size="23" font-weight="700" fill="#2e564a"><text x="35" y="305">الوعر</text><text x="265" y="261">الحديقة</text><text x="491" y="190">دوار الوعر</text><text x="615" y="52">وسط حمص</text></g>'+
      '<text x="15" y="25" font-family="Tahoma,Arial" font-size="17" fill="#719085">خريطة توضيحية · غير مخصصة للملاحة</text></svg></div>'+
      '<div class="legend">● نقاط التقاء &nbsp; ◼ سرافيس تجريبية &nbsp; | &nbsp; الوعر ↔ وسط المدينة</div>';
  }
  function hero(title,text){
    return '<section class="hero"><span class="eyebrow">حمص / الوعر · رحلة تجريبية</span><h1>'+title+'</h1><p>'+text+'</p></section>';
  }
  function card(r,role){
    const name=bus(r.busId);
    let buttons="";
    if(role==="rider"){
      if(r.status==="accepted") buttons+=btn("ركبت","rider-confirm",r.id,false,false);
      if(["pending","accepted"].includes(r.status))buttons+=btn("إلغاء الطلب","cancel",r.id,true,false);
    }
    if(role==="driver"){
      if(r.status==="pending")buttons+=btn("قبول الطلب","accept",r.id,false,filled(state.bus)>=(bus(state.bus)||buses[0]).seats);
      if(r.status==="rider_confirmed"&&r.busId===state.bus)buttons+=btn("تأكيد ركوب الراكب","driver-confirm",r.id,false,false);
      if(r.status==="boarded"&&r.busId===state.bus)buttons+=btn("إنهاء الرحلة","complete",r.id,false,false);
    }
    return '<article class="item"><b>طلب #'+esc(r.id.slice(-5))+'</b><span class="pill">'+esc(labels[r.status]||r.status)+'</span>'+
      '<p>من '+esc(r.origin)+' إلى '+esc(r.destination)+'</p><p>نقطة الالتقاء: '+esc(r.stop)+'</p>'+
      (name?'<p>السرفيس: '+esc(name.name)+' - '+esc(name.driver)+'</p>':'')+
      (buttons?'<div class="actions">'+buttons+'</div>':'')+'</article>';
  }
  function rider(){
    const current=state.requests.find(active);
    const choices=destinations.map(d=>'<option value="'+esc(d)+'"'+(state.destination===d?' selected':'')+'>'+(d?esc(d):'اختر وجهتك')+'</option>').join("");
    const stopChoices=stops.map(s=>'<option value="'+esc(s)+'"'+(state.stop===s?' selected':'')+'>'+esc(s)+'</option>').join("");
    return hero("مشوارك الليلة، صار أسهل.","موقعك الحالي ووجهتك… والباقي على خطّك.")+
      '<div class="grid"><section class="card"><h2>من موقعك، لوين رايح؟</h2><label>موقعك الحالي</label>'+
      '<div class="field"><p>'+(state.location?esc(state.origin):'اسمح بالموقع لنحدد نقطة البداية.')+'</p><div class="actions">'+
      btn("استخدم موقعي الحالي","geolocate","",true,false)+btn("جرّب موقعًا توضيحيًا في الوعر","demo-location","",true,false)+'</div></div>'+
      '<label for="destination">لوين رايح؟</label><select id="destination" class="select">'+choices+'</select>'+
      '<p class="muted">من وجهتك منعرف الخط والاتجاه المناسبين.</p>'+
      '<label for="stop">اختَر نقطة التقاء</label><select id="stop" class="select">'+stopChoices+'</select>'+
      '<div class="note"><b>راكب واحد · مقعد واحد</b><br>طلب واحد فعّال لكل حساب (داخل هذا العرض فقط).</div>'+
      '<div class="actions">'+btn("اطلب سرفيس","request","",false,!!current)+'</div>'+
      '<p class="muted">وجهتك تحدد الخط والاتجاه؛ هذه محاكاة، وليست خدمة حجز.</p></section>'+
      '<section class="card"><h2>خط الوعر ← وسط المدينة</h2><p class="muted">خط مباشر، ونقاط التقاء واضحة.</p>'+
      mapView()+'<div class="kpis"><div class="kpi"><strong>٦</strong><span>نقاط التقاء</span></div>'+
      '<div class="kpi"><strong>٣</strong><span>سرافيس تجريبية</span></div><div class="kpi"><strong>١٢</strong><span>شخص ناطر (عرض)</span></div></div>'+
      '<p class="muted">اختَر نقطة التقاء واضحة، وتأكد من لوحة السرفيس قبل ما تطلع.</p></section></div>'+
      '<section class="card section" id="journeys"><h2>رحلتي</h2>'+(current?card(current,"rider"):'<div class="empty">لا يوجد طلب فعّال بعد.</div>')+'</section>';
  }
  function driver(){
    const chosen=bus(state.bus)||buses[0];
    const pending=state.requests.filter(r=>r.status==="pending");
    const mine=state.requests.filter(r=>r.busId===state.bus&&active(r));
    return hero("طلبات الركاب على خطّك","السائق يعرف أنك تنتظره في اتجاهه.")+
    '<section class="card section"><h2>اختر السرفيس</h2><div class="cars">'+buses.map(b=>
      '<button type="button" data-action="choose-bus" data-id="'+b.id+'" aria-pressed="'+(state.bus===b.id)+'" class="car '+(state.bus===b.id?'selected':'')+'"><b>'+esc(b.name)+'</b><small>'+esc(b.driver)+'</small><small>المتاح '+fmt(b.seats-filled(b.id))+' من '+fmt(b.seats)+' مقعد</small></button>'
    ).join("")+'</div></section>'+
    '<section class="card section"><h2>طلبات بانتظار سائق</h2><p class="muted">القبول هنا محلي داخل المتصفح؛ لا توجد مزامنة بين أجهزة حقيقية.</p>'+
    (pending.length?pending.map(r=>card(r,"driver")).join(""):'<div class="empty">لا يوجد ركاب بانتظار قبول.</div>')+'</section>'+
    '<section class="card section"><h2>طلبات '+esc(chosen.name)+'</h2>'+
    (mine.length?mine.map(r=>card(r,"driver")).join(""):'<div class="empty">ما في طلبات مخصصة للسرفيس حالياً.</div>')+'</section>';
  }
  function admin(){
    return hero("متابعة السرافيس والطلبات","عرض تجريبي للإدارة، من دون بيانات مستخدمين حقيقية.")+
      '<section class="card section"><h2>إحصاءات العرض</h2><div class="kpis">'+
      '<div class="kpi"><strong>'+fmt(state.requests.length)+'</strong><span>جميع الطلبات</span></div>'+
      '<div class="kpi"><strong>'+fmt(state.requests.filter(active).length)+'</strong><span>الطلبات الفعّالة</span></div>'+
      '<div class="kpi"><strong>'+fmt(state.requests.filter(r=>r.status==="boarded").length)+'</strong><span>على متن السرفيس</span></div></div></section>'+
      '<section class="card section"><h2>السرافيس</h2><div class="cars">'+buses.map(b=>
      '<div class="car"><b>'+esc(b.name)+'</b><small>'+esc(b.driver)+'</small><small>المشغول '+fmt(filled(b.id))+' / '+fmt(b.seats)+'</small></div>').join("")+'</div></section>'+
      '<section class="card section"><h2>طلبات التجربة</h2>'+
      (state.requests.length?state.requests.slice().reverse().map(r=>card(r,"admin")).join(""):'<div class="empty">ما في طلبات بعد.</div>')+
      '<div class="actions">'+btn("إعادة التجربة","reset","",true,false)+'</div></section>';
  }
  function render(){
    const tabs=[["rider","الراكب"],["driver","السائق"],["admin","الإدارة"]];
    root.innerHTML='<div class="page"><header class="top"><a class="logo" href="#" data-action="home"><span class="icon">س</span><span>سرفيسنا<small>على خطّك</small></span></a>'+
      '<nav class="nav"><a href="#" data-action="home">الرئيسية</a><a href="#journeys">رحلاتي</a><a href="#help">مساعدة</a></nav>'+
      '<span class="badge">معاينة التصميم · بيانات تجريبية</span></header>'+
      '<div class="tabs">'+tabs.map(([id,title])=>
      '<button type="button" data-action="role" data-id="'+id+'" class="'+(state.role===id?'active':'')+'" aria-pressed="'+(state.role===id)+'">'+title+'</button>').join("")+
      '<button type="button" class="reset" data-action="reset">إعادة التجربة ↺</button></div>'+
      (state.notice?'<div class="alert '+(state.notice.startsWith("✓")?'ok':'')+'" role="status">'+esc(state.notice)+'</div>':'')+
      (state.role==="rider"?rider():state.role==="driver"?driver():admin())+
      '<footer class="foot" id="help">سرفيسنا، من هون بتبلّش الرحلة. · تصميم تجريبي — لا يُنشئ حجوزات فعلية.<br>إعادة بناء مستقلة من محتوى نسخة ChatGPT؛ الكود الأصلي للموقع لم يكن متاحًا.</footer></div>';
    persist();
  }
  function notice(text){state.notice=text;render();}
  document.addEventListener("change",e=>{
    if(e.target.id==="destination"){state.destination=e.target.value;state.notice="";render();}
    if(e.target.id==="stop"){state.stop=e.target.value;state.notice="";render();}
  });
  document.addEventListener("click",e=>{
    const t=e.target.closest("[data-action]");if(!t)return;
    e.preventDefault();const a=t.dataset.action,id=t.dataset.id;
    if(a==="role"){state.role=id;state.notice="";return render();}
    if(a==="home"){state.role="rider";state.notice="";return render();}
    if(a==="choose-bus"){state.bus=id;state.notice="";return render();}
    if(a==="reset"){state=initial();return notice("✓ تمت إعادة ضبط بيانات العرض.");}
    if(a==="demo-location"){state.location=true;state.origin="حي الوعر (موقع توضيحي)";return notice("✓ تم اختيار موقع الوعر التجريبي.");}
    if(a==="geolocate"){
      if(!navigator.geolocation)return notice("المتصفح لا يدعم تحديد الموقع.");
      navigator.geolocation.getCurrentPosition(
        ()=>{state.location=true;state.origin="موقع الجهاز الحالي (تقريبي)";notice("✓ تم السماح بالموقع. نقاط الالتقاء تبقى تجريبية.");},
        ()=>notice("تعذّر تحديد الموقع. يمكنك استخدام الموقع التوضيحي."),
        {enableHighAccuracy:false,timeout:7000}
      );return;
    }
    if(a==="request"){
      if(state.requests.some(active))return notice("يوجد طلب فعّال بالفعل.");
      if(!state.location)return notice("يرجى اختيار الموقع أولاً.");
      if(!state.destination)return notice("يرجى اختيار الوجهة.");
      if(state.destination==="وجهة خارج الخط التجريبي")return notice("الوجهة خارج الخط التجريبي.");
      state.requests.push({id:String(Date.now()),origin:state.origin,destination:state.destination,stop:state.stop,status:"pending",busId:null});
      return notice("✓ أُنشئ طلب تجريبي. جرّب دور السائق لقبوله.");
    }
    const r=state.requests.find(x=>x.id===id);if(!r)return;
    if(a==="cancel"&&["pending","accepted"].includes(r.status)){r.status="cancelled";return notice("✓ تم إلغاء الطلب.");}
    if(a==="accept"&&r.status==="pending"){
      const selected=bus(state.bus);if(!selected||filled(selected.id)>=selected.seats)return notice("لا توجد مقاعد متاحة.");
      r.busId=selected.id;r.status="accepted";return notice("✓ قُبل الطلب من السائق.");
    }
    if(a==="rider-confirm"&&r.status==="accepted"){r.status="rider_confirmed";return notice("✓ الراكب أكد ركوبه، بانتظار تأكيد السائق.");}
    if(a==="driver-confirm"&&r.status==="rider_confirmed"&&r.busId===state.bus){r.status="boarded";return notice("✓ أكد السائق ركوب الراكب.");}
    if(a==="complete"&&r.status==="boarded"&&r.busId===state.bus){r.status="completed";return notice("✓ اكتملت الرحلة التجريبية.");}
  });
  render();
})();
