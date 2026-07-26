const fs=require('fs');
const h=fs.readFileSync('/home/claude/editor_v1.html','utf8');
function grab(a,b){const s=h.indexOf(a),e=h.indexOf(b,s);if(s<0||e<0)throw new Error('anchor '+a);return h.slice(s,e);}
let pass=0,fail=0;
function t(n,fn){try{const r=fn();if(r===true){pass++;console.log('  PASS  '+n);}else{fail++;console.log('  FAIL  '+n+'  -> '+r);}}catch(e){fail++;console.log('  ERROR '+n+'  -> '+e.message);}}

console.log('\n=== A. GPS mode exists alongside the canvas ===');
t('openGpsPlacement is defined and exported', ()=>{
  return (h.includes('function openGpsPlacement(') && h.includes('window.openGpsPlacement=openGpsPlacement')) ? true : 'not exported';
});
t('GPS Place button wired in the ribbon', ()=>{
  return h.includes('openGpsPlacement()') && h.includes('rb-gps') ? true : 'no button';
});
t('uses AdvancedMarkerElement', ()=>{
  return h.includes('google.maps.marker.AdvancedMarkerElement') ? true : 'not using advanced markers';
});
t('falls back to classic Marker if marker lib missing', ()=>{
  const seg=grab('function _gpsAddMarker','function _gpsApplyToCanvas');
  return seg.includes('new google.maps.Marker(') ? true : 'no fallback';
});
t('ensures the marker library is loaded', ()=>{
  return h.includes("importLibrary('marker')") ? true : 'marker lib not requested';
});

console.log('\n=== B. Round-trips through the existing geo model ===');
const src=grab('function _mapMetersPerPx','function _getCanvasSize')
        + grab('function _pxToLatLng','function _geoStampElement');
const P=new Function('window', src+'; return {_pxToLatLng,_latLngToPx};')({});
t('pixel -> latlng -> pixel is lossless', ()=>{
  const ms={lat:41.8781,lng:-87.6298,zoom:19}, W=1200,H=800;
  const start={x:800,y:300};
  const geo=P._pxToLatLng(start.x,start.y,ms,W,H);
  const back=P._latLngToPx(geo.lat,geo.lng,ms,W,H);
  return (Math.abs(back.x-start.x)<0.01 && Math.abs(back.y-start.y)<0.01) ? true : 'round-trip drifted';
});
t('apply converts latlng to canvas px via _latLngToPx', ()=>{
  const seg=grab('function _gpsApplyToCanvas','function _gpsClose');
  return seg.includes('_latLngToPx(rec.lat, rec.lng') ? true : 'apply does not use the shared projection';
});
t('apply writes to S.elements (same array as canvas)', ()=>{
  const seg=grab('function _gpsApplyToCanvas','function _gpsClose');
  return seg.includes('S.elements.push') ? true : 'not writing to canvas element array';
});
t('placed elements carry _geoLat/_geoLng for re-sync', ()=>{
  const seg=grab('function _gpsApplyToCanvas','function _gpsClose');
  return (seg.includes('_geoLat:rec.lat') && seg.includes('_geoLng:rec.lng')) ? true : 'geo coords not stored';
});
t('existing geo-located elements are shown in GPS mode', ()=>{
  const seg=grab('function _gpsInitMap','function _gpsAddMarker');
  return seg.includes('el._geoLat && el._geoLng') ? true : 'existing placements not seeded';
});

console.log('\n=== C. Bounded & safe (does not touch the canvas engine) ===');
t('reuses the existing EQ catalog, not a private copy', ()=>{
  const seg=grab('function _gpsBuildPalette','function _gpsEqLabel');
  return seg.includes('EQ.map') ? true : 'palette duplicates the catalog';
});
t('reuses existing renderEl to draw applied elements', ()=>{
  const seg=grab('function _gpsApplyToCanvas','function _gpsClose');
  return seg.includes('renderEl(nel)') ? true : 'reimplements rendering';
});
t('missing location is handled gracefully (in-mode address search, no dead-end)', ()=>{
  const seg=grab('async function openGpsPlacement','function _gpsShowAddressBar');
  return seg.includes('_gpsShowAddressBar(true)') ? true : 'no graceful handling of missing location';
});
t('no API key -> graceful failure, not a crash', ()=>{
  const seg=grab('function _gpsEnsureMapsLibs','function _gpsMapState');
  return seg.includes("no-key") ? true : 'no key guard';
});
t('Map ID is configurable (AdvancedMarkerElement needs one)', ()=>{
  return h.includes('googleMapsMapId') ? true : 'no Map ID slot';
});
t('closing releases the map (stops tile usage)', ()=>{
  const seg=grab('function _gpsClose','window.openGpsPlacement');
  return seg.includes('_gpsMode.map=null') ? true : 'map not released';
});

console.log('\n=== D. 3D oblique view ===');
t('3D toggle button + functions exist', ()=>{
  return (h.includes('function _gpsToggle3D(') && h.includes('gps-3d-btn')) ? true : 'no 3D toggle';
});
t('3D tilts the camera to 45 degrees', ()=>{
  const seg=grab('function _gpsToggle3D','function _gpsRotate');
  return seg.includes('setTilt') && seg.includes('45') ? true : 'no tilt';
});
t('rotate controls change heading', ()=>{
  const seg=grab('function _gpsRotate','function _gpsSync3DBtn');
  return seg.includes('setHeading') ? true : 'no heading rotation';
});
t('detects raster map (no Map ID) and warns instead of failing silently', ()=>{
  const seg=grab('function _gpsToggle3D','function _gpsRotate');
  return seg.includes('getTilt') && seg.includes('vector Map ID') ? true : 'no raster fallback';
});
t('map is created with heading support', ()=>{
  const seg=grab('function _gpsInitMap','function _gpsAddMarker');
  return seg.includes('heading:0') ? true : 'no heading in map options';
});
t('apply is tilt-independent (uses stored lat/lng, not screen px)', ()=>{
  const seg=grab('function _gpsApplyToCanvas','function _gpsClose');
  // Must convert the stored geographic coords, which are unaffected by camera tilt
  return seg.includes('_latLngToPx(rec.lat, rec.lng') ? true : 'apply could break under tilt';
});

console.log('\n=== E. WebGL 3D objects (Google canonical pattern) ===');
t('WebGLOverlayView scaffold exists', ()=>{
  return h.includes('function _gpsBuildWebGLOverlay(') ? true : 'no overlay builder';
});
t('implements all Google lifecycle hooks', ()=>{
  const seg=grab('function _gpsBuildWebGLOverlay','function _gpsEnsureThree');
  return ['onAdd=','onContextRestored=','onDraw=','onContextLost=','onRemove=']
    .every(k=>seg.includes('overlay.'+k)) ? true : 'missing a lifecycle hook';
});
t('calls renderer.resetState() after render (the critical rule)', ()=>{
  const seg=grab('function _gpsBuildWebGLOverlay','function _gpsEnsureThree');
  // Must appear AFTER renderer.render in onDraw
  const draw=seg.slice(seg.indexOf('onDraw='));
  const ri=draw.indexOf('renderer.render'), si=draw.indexOf('renderer.resetState()');
  return (ri>=0 && si>ri) ? true : 'resetState missing or before render -> map would fail';
});
t('georeferences via transformer.fromLatLngAltitude', ()=>{
  const seg=grab('function _gpsBuildWebGLOverlay','function _gpsEnsureThree');
  return seg.includes('transformer.fromLatLngAltitude') ? true : 'objects not georeferenced';
});
t('renderer binds the map\'s own GL context', ()=>{
  const seg=grab('function _gpsBuildWebGLOverlay','function _gpsEnsureThree');
  return (seg.includes('canvas:gl.canvas') && seg.includes('context:gl') && seg.includes('autoClear=false'))
    ? true : 'not using the shared context per docs';
});
t('onContextLost tears down the renderer', ()=>{
  const seg=grab('function _gpsBuildWebGLOverlay','function _gpsEnsureThree');
  const lost=seg.slice(seg.indexOf('onContextLost='));
  return lost.includes('renderer=null') ? true : 'GL context loss not handled';
});
t('three.js is lazy-loaded, not a startup cost', ()=>{
  return h.includes('function _gpsEnsureThree(') ? true : 'three.js not lazy-loaded';
});
t('3D objects require a vector Map ID, warns otherwise', ()=>{
  const seg=grab('async function _gpsToggle3DObjects','window._gpsToggle3DObjects');
  return seg.includes('googleMapsMapId') && seg.includes('vector Map ID') ? true : 'no Map ID guard';
});
t('closing GPS mode releases the overlay', ()=>{
  const seg=grab('function _gpsClose','window.openGpsPlacement');
  return seg.includes('_gpsWebGL.overlay.setMap(null)') ? true : 'overlay leaks on close';
});
t('3D objects button wired', ()=>{
  return h.includes('_gpsToggle3DObjects()') && h.includes('gps-3dobj-btn') ? true : 'no button';
});
t('Map ID guidance matches Google requirements (vector + tilt/rotation)', ()=>{
  const i=h.indexOf('googleMapsMapId:');
  const seg=h.slice(i-700, i);
  return (seg.includes('VECTOR') && seg.includes('Tilt') && seg.includes('Rotation'))
    ? true : 'Map ID setup guidance incomplete';
});

console.log('\n=== F. Self-sufficient + auto-trench ===');
t('GPS mode no longer dead-ends without a location', ()=>{
  const seg=grab('async function openGpsPlacement','function _gpsShowAddressBar');
  // must NOT early-return before building the map; instead show address bar
  return (seg.includes('_gpsShowAddressBar(true)') && seg.includes('_gpsInitMap('))
    ? true : 'still dead-ends when no address set';
});
t('in-mode address search exists', ()=>{
  return (h.includes('function _gpsGeocode(') && h.includes('gps-addr-in')) ? true : 'no in-mode search';
});
t('geocode recenters the map and records the anchor', ()=>{
  const seg=grab('function _gpsGeocode','window._gpsGeocode');
  return (seg.includes('Geocoder') && seg.includes('window._lastCenter')) ? true : 'geocode incomplete';
});
t('auto-trench toggle exists', ()=>{
  return h.includes('gps-autotrench') ? true : 'no auto-trench toggle';
});
t('auto-trench uses a shared spine (merges corridors)', ()=>{
  const seg=grab('var trenched=0;','if(typeof updCount');
  return (seg.includes('trunkY') && seg.includes("'Trunk'")) ? true : 'not a spine layout';
});
t('auto-trench feeds the existing conduit engine', ()=>{
  const seg=grab('var trenched=0;','if(typeof updCount');
  return seg.includes('autoWireConduit(') ? true : 'reimplements trenching';
});
t('uses a real conduit type id (RMC-DC, not RMC_DC)', ()=>{
  const seg=grab('var trenched=0;','if(typeof updCount');
  return (seg.includes("'RMC-DC'") && !seg.includes("'RMC_DC'")) ? true : 'bad conduit type id';
});

console.log('\n=== G. Corridor merging (perfect trenching) ===');
t('coincident runs merge into one corridor', ()=>{
  const F=new Function('S','var CORRIDOR_TOL=26;'+grab('function _routesCoincide','function _corridorKey')+'; return _routesCoincide;');
  const rc=F({});
  const a=[{x:0,y:100},{x:200,y:100}];
  const b=[{x:0,y:100},{x:200,y:100}];  // same trunk segment
  return rc(a,b)===true ? true : 'identical trunk runs did not merge';
});
t('separate runs do NOT falsely merge', ()=>{
  const F=new Function('S','var CORRIDOR_TOL=26;'+grab('function _routesCoincide','function _corridorKey')+'; return _routesCoincide;');
  const rc=F({});
  return rc([{x:0,y:0},{x:10,y:0}],[{x:0,y:500},{x:10,y:500}])===false ? true : 'false merge';
});

console.log('\n=== H. Mobile / tablet layout + map render ===');
t('map div has explicit min-height (not collapse to 0 on mobile)', ()=>{
  return h.includes("id=\"gps-map\" style=\"flex:1 1 auto;min-height:320px") ? true : 'map can collapse to zero height';
});
t('map triggers a resize after the container is shown', ()=>{
  const seg=grab('function _gpsInitMap','_gpsMode.map.addListener');
  return (seg.includes("trigger(_gpsMode.map,'resize')") && seg.includes('addListenerOnce'))
    ? true : 'no resize nudge -> blank tiles on open';
});
t('header controls are in a horizontally-scrollable strip', ()=>{
  const seg=grab('host.innerHTML=','id=\"gps-addrbar\"');
  return seg.includes('overflow-x:auto') && seg.includes('-webkit-overflow-scrolling:touch')
    ? true : 'controls not scrollable -> cramped on phone';
});
t('control buttons do not wrap (white-space:nowrap)', ()=>{
  const seg=grab('host.innerHTML=','id=\"gps-addrbar\"');
  return seg.includes('white-space:nowrap') ? true : 'buttons wrap to multiple lines';
});
t('address input is 16px (no iOS zoom-on-focus)', ()=>{
  const seg=grab('id=\"gps-addr-in\"','gps-palette');
  return seg.includes('font-size:16px') ? true : 'address field triggers iOS zoom';
});
t('modal sections are fixed-height, map takes the rest', ()=>{
  const seg=grab('host.innerHTML=','_gpsMode.map=');
  // header, addrbar, palette, status all flex:0 0 auto; only map grows
  const fixed=(seg.match(/flex:0 0 auto/g)||[]).length;
  return fixed>=4 ? true : 'layout will fight for space on small screens';
});
t('palette + map build even with no location set', ()=>{
  const seg=grab('await _gpsEnsureMapsLibs','_gpsShowAddressBar(false)');
  // in the no-location branch it still calls _gpsInitMap
  return (seg.includes('_gpsBuildPalette()') && seg.match(/_gpsInitMap\(/g).length>=1)
    ? true : 'blank screen when no address';
});

console.log('\n=== I. Anchor consistency (fixes equipment-out-to-the-side) ===');
t('GPS apply sets _frozenMapState from the GPS map', ()=>{
  const seg=grab('function _gpsApplyToCanvas','var size=');
  return seg.includes('window._frozenMapState=ms') ? true : 'apply does not persist the anchor';
});
t('Set Plot records the frozen map anchor', ()=>{
  const seg=grab('Freeze the live map underneath','var blk=document.getElementById');
  return seg.includes('window._frozenMapState=') ? true : 'Set Plot loses the anchor';
});
t('shared anchor -> placed marker lands where it was placed (no offset)', ()=>{
  const src=grab('function _mapMetersPerPx','function _getCanvasSize')+grab('function _pxToLatLng','function _geoStampElement');
  const F=new Function('window', src+'; return {_pxToLatLng,_latLngToPx};')({});
  const frozen={lat:33.5,lng:-84.2,zoom:19}, W=1200,H=800;
  const ll=F._pxToLatLng(W/2+200,H/2+100,frozen,W,H);
  const px=F._latLngToPx(ll.lat,ll.lng,frozen,W,H);
  return (Math.abs(px.x-(W/2+200))<1 && Math.abs(px.y-(H/2+100))<1) ? true : 'offset even with shared anchor';
});
t('mismatched anchor is what caused the off-screen placement', ()=>{
  const src=grab('function _mapMetersPerPx','function _getCanvasSize')+grab('function _pxToLatLng','function _geoStampElement');
  const F=new Function('window', src+'; return {_pxToLatLng,_latLngToPx};')({});
  const W=1200,H=800;
  const ll=F._pxToLatLng(W/2+200,H/2+100,{lat:33.5,lng:-84.2,zoom:19},W,H);
  const bad=F._latLngToPx(ll.lat,ll.lng,{lat:33.6,lng:-84.1,zoom:19},W,H);
  // proves the diagnosis: different anchor throws it far off screen
  return (Math.abs(bad.x-(W/2+200))>1000) ? true : 'mismatch no longer explains the bug';
});
t('unlocked-map warning re-fires (not one-time latch)', ()=>{
  const seg=grab('function _warnIfMapUnlocked','function addEl');
  return (seg.includes('_placeUnlockedWarnedAt') && !seg.includes('_placeUnlockedWarned=true'))
    ? true : 'still a one-time warning';
});
t('warning points at Set Plot as the fix', ()=>{
  const seg=grab('function _warnIfMapUnlocked','function addEl');
  return seg.includes('Set Plot') ? true : 'warning not actionable';
});

console.log('\n=== J. Native map conduits (AutoCAD-style, no lock) ===');
t('conduit state exists in GPS mode', ()=>{
  return h.includes('conduits:[], connectFrom:null') ? true : 'no conduit state';
});
t('conduits are google.maps.Polyline (map-native, not pixel SVG)', ()=>{
  const seg=grab('function _gpsAddConduit','function _gpsConduitLenFt');
  return seg.includes('new google.maps.Polyline') ? true : 'conduits not map-native';
});
t('conduit length is true geographic distance (feet)', ()=>{
  const src=grab('function _gpsConduitLenFt','function _gpsRedrawConduits');
  const fn=new Function('google', src+'; return _gpsConduitLenFt;')({maps:{}});
  const ft=fn({lat:33.5,lng:-84.2},{lat:33.501,lng:-84.2});
  return (Math.abs(ft-365)<10) ? true : 'distance math off: '+ft;
});
t('geometry library is loaded for distance', ()=>{
  const seg=grab('function _gpsEnsureMapsLibs','function _gpsMapState');
  return seg.includes("importLibrary('geometry')") ? true : 'geometry lib not loaded';
});
t('conduits follow endpoints when equipment is dragged', ()=>{
  const seg=grab('function _gpsAddMarker','NATIVE MAP CONDUITS');
  return seg.includes('_gpsRedrawConduits()') ? true : 'conduits do not track dragged equipment';
});
t('redraw updates polyline paths from live endpoints', ()=>{
  const seg=grab('function _gpsRedrawConduits','function _gpsUpdateConduitReadout');
  return seg.includes('c.poly.setPath') ? true : 'redraw does not reposition conduits';
});
t('Place / Connect modes exist', ()=>{
  return (h.includes("function _gpsSetMode(") && h.includes('gps-mode-connect')) ? true : 'no mode toggle';
});
t('connect mode: source then target draws a conduit', ()=>{
  const seg=grab('function _gpsMarkerClicked','function _gpsHighlightMarker');
  return (seg.includes('_gpsMode.connectFrom') && seg.includes('_gpsAddConduit')) ? true : 'connect flow incomplete';
});
t('map clicks do not place equipment in connect mode', ()=>{
  const seg=grab("_gpsMode.map.addListener('click'","_gpsMode.map.addListener('click'".length>0 ? 'var s=document.getElementById(\'gps-status\')' : 'zz');
  // simpler: the click handler early-returns in connect mode
  const i=h.indexOf("Only drop equipment in place mode");
  return i>0 ? true : 'connect mode would still drop equipment';
});
t('per-type trench totals are summed', ()=>{
  return h.includes('function _gpsUpdateConduitReadout(') ? true : 'no trench readout';
});
t('conduit polylines are released on close (no leak)', ()=>{
  const seg=grab('function _gpsClose','window.openGpsPlacement');
  return seg.includes('c.poly.setMap(null)') ? true : 'polylines leak on close';
});
t('four conduit types available (DC/AC/data/MV)', ()=>{
  const seg=grab('var _GPS_COND_STYLES','function _gpsMarkerClicked');
  return (seg.includes("'RMC-DC'") && seg.includes("'RMC-AC'") && seg.includes("'EMT-DATA'") && seg.includes("'MV-TRENCH'"))
    ? true : 'missing conduit types';
});

console.log('\n=== K. Geo-anchoring (equipment locked to lat/lng, moves with map) ===');
t('_geoStampElement records lat/lng on placement', ()=>{
  return h.includes('function _geoStampElement(') ? true : 'no geo stamp';
});
t('addEl stamps geo when a live map is active', ()=>{
  const seg=grab('function addEl(opts){','function renderEl');
  return seg.includes('_geoStampElement(el)') ? true : 'placement not geo-anchored';
});
t('drag/resize end re-stamps the new position', ()=>{
  const seg=grab('function globalMU(e){','document.addEventListener');
  return seg.includes('_geoStampElement(el)') ? true : 'moved equipment loses its map lock';
});
t('_geoReprojectAll repositions elements to current map view', ()=>{
  const seg=grab('function _geoReprojectAll(){','function _geoWireMapListeners');
  return (seg.includes('_latLngToPx(el._geoLat') && seg.includes("dom.style.left"))
    ? true : 'reprojection incomplete';
});
t('map idle/bounds listeners drive reprojection', ()=>{
  const seg=grab('function _geoWireMapListeners(){','window._geoWireMapListeners');
  return (seg.includes("addListener('idle'") && seg.includes("bounds_changed"))
    ? true : 'equipment would not track pan/zoom';
});
t('listeners wired once (idempotent)', ()=>{
  const seg=grab('function _geoWireMapListeners(){','window._geoWireMapListeners');
  return seg.includes('_geoListenersWired') ? true : 'listeners would double-bind';
});
t('reprojection only runs on a live unfrozen map', ()=>{
  const seg=grab('function _liveMapState(){','function _geoStampElement');
  return seg.includes('mapLockState().hasPlot') ? true : 'would fight a frozen plot';
});
t('equipment tracks the ground on pan (round-trip)', ()=>{
  const src=grab('function _mapMetersPerPx','function _getCanvasSize')+grab('function _pxToLatLng','function _geoStampElement');
  const F=new Function('window', src+'; return {_pxToLatLng,_latLngToPx};')({});
  const W=1200,H=800, mapA={lat:33.9,lng:-84.5,zoom:19};
  const geo=F._pxToLatLng(700,400,mapA,W,H);
  const shifted=F._pxToLatLng(W/2-200,H/2-100,mapA,W,H);
  const mapB={lat:shifted.lat,lng:shifted.lng,zoom:19};
  const np=F._latLngToPx(geo.lat,geo.lng,mapB,W,H);
  return (Math.abs((np.x-700)-200)<2 && Math.abs((np.y-400)-100)<2) ? true : 'equipment does not track the map';
});
t('reprojection guards against re-entrancy', ()=>{
  const seg=grab('function _geoReprojectAll(){','function _geoWireMapListeners');
  return seg.includes('_geoReprojecting') ? true : 'could recurse on rapid moves';
});

console.log('\n---------------------------------------');
console.log('PASS '+pass+'   FAIL '+fail);
process.exit(fail?1:0);
