export const root = 100000;

const cache = new Map();

export async function readJson(path) {
  const response = await fetch(import.meta.env.BASE_URL + path);
  if (!response.ok) throw new Error('地图数据加载失败');
  return response.json();
}

export function shape(id) {
  if (!cache.has(id)) {
    const request = readJson(id === root ? 'china.json' : 'shapes/' + id + '.json')
      .catch(() => { cache.delete(id); return null; });
    cache.set(id, request);
  }
  return cache.get(id);
}

const groups = f => f.geometry.type==='Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;

export function drawMap(geo, areas, name, overlays = []) {
  const valid = new Set(areas.map(area => area.adcode));
  const features = geo?.features.filter(f =>
    (valid.has(f.properties.adcode) || f.properties.adcode === '100000_JD') && f.geometry
  ) || [];
  if (!features.length) return null;

  const width=850,height=520;
  const project = ([x,y])=>[x,-Math.log(Math.tan(Math.PI/4+y*Math.PI/360))*180/Math.PI];
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  for(const f of features) for(const polygon of groups(f)) for(const ring of polygon) for(const point of ring) {
    const [x,y]=project(point);minX=Math.min(x,minX);maxX=Math.max(x,maxX);minY=Math.min(y,minY);maxY=Math.max(y,maxY);
  }
  const scale=Math.min((width-35)/(maxX-minX),(height-35)/(maxY-minY));
  const xy = point => {
    const [x,y]=project(point);
    return [(width/2+(x-(minX+maxX)/2)*scale).toFixed(2),(height/2+(y-(minY+maxY)/2)*scale).toFixed(2)];
  };

  const projected = new WeakMap();
  function projectFeature(feature) {
    if (projected.has(feature)) return projected.get(feature);
    const { adcode, center, centroid } = feature.properties;
    const bounds = [Infinity, Infinity, -Infinity, -Infinity];
    const path = groups(feature).flatMap(polygon => polygon.map(ring => {
      const points = ring.map(point => {
        const [x, y] = xy(point).map(Number);
        bounds[0] = Math.min(bounds[0], x);
        bounds[1] = Math.min(bounds[1], y);
        bounds[2] = Math.max(bounds[2], x);
        bounds[3] = Math.max(bounds[3], y);
        return x + ',' + y;
      });
      return 'M' + points.join('L') + 'Z';
    })).join(' ');
    const anchor = centroid || center;
    let label;
    if (anchor && adcode !== '100000_JD') {
      const [x, y] = xy(anchor).map(Number);
      label = { adcode, x, y, text: name(adcode).replace(/(省|市)$/, '') };
    }
    const item = { adcode, path, bounds, label };
    projected.set(feature, item);
    return item;
  }
  const paths = features.map(feature => {
    const item = projectFeature(feature);
    return { ...item, outline: !valid.has(item.adcode) };
  });
  // Fit the SVG to the actual map bounds so narrow screens don't scale empty margins.
  const padding = 18;
  const mapWidth = (maxX - minX) * scale;
  const mapHeight = (maxY - minY) * scale;
  const viewBox = [
    (width - mapWidth) / 2 - padding,
    (height - mapHeight) / 2 - padding,
    mapWidth + padding * 2,
    mapHeight + padding * 2,
  ].join(' ');
  return {
    paths, viewBox, projectFeature,
    projectPoint: point => xy(point).map(Number),
    overlays: overlays.map(projectFeature),
  };
}

function inRing([x,y],ring) {
  let inside=false;
  for(let i=0,j=ring.length-1;i<ring.length;j=i++){
    const [a,b]=ring[i],[c,d]=ring[j];
    if((b>y)!==(d>y)&&x<(c-a)*(y-b)/(d-b)+a)inside=!inside;
  }
  return inside;
}
export function match(geo,point,parent,byId) {
  return geo?.features.find(f=>byId[f.properties.adcode]?.parent.adcode===parent&&f.geometry&&groups(f).some(poly=>inRing(point,poly[0])&&!poly.slice(1).some(ring=>inRing(point,ring))))?.properties.adcode;
}
export function coordinates(lng,lat) {
  if(lng<72.004||lng>137.8347||lat<0.8293||lat>55.8271)return [lng,lat];
  const x=lng-105,y=lat-35,pi=Math.PI;
  const common=(20*Math.sin(6*x*pi)+20*Math.sin(2*x*pi))*2/3;
  const dy=-100+2*x+3*y+.2*y*y+.1*x*y+.2*Math.sqrt(Math.abs(x))+common+
    (20*Math.sin(y*pi)+40*Math.sin(y*pi/3)+160*Math.sin(y*pi/12)+320*Math.sin(y*pi/30))*2/3;
  const dx=300+x+2*y+.1*x*x+.1*x*y+.1*Math.sqrt(Math.abs(x))+common+
    (20*Math.sin(x*pi)+40*Math.sin(x*pi/3)+150*Math.sin(x*pi/12)+300*Math.sin(x*pi/30))*2/3;
  const rad=lat/180*pi,magic=1-.006693421622965943*Math.sin(rad)**2,a=6378245;
  return [lng+dx*180/(a/Math.sqrt(magic)*Math.cos(rad)*pi),
    lat+dy*180/(a*(1-.006693421622965943)/magic**1.5*pi)];
}
