import { isMapPoint } from './map.js';

const key = import.meta.env.VITE_AMAP_KEY;
const serviceHost = import.meta.env.VITE_AMAP_SERVICE_HOST
  || (import.meta.env.VITE_AMAP_LOCAL_PROXY ? window.location.origin + '/_AMapService' : '');
export const amapConfigured = Boolean(key && serviceHost);

let serviceRequest;
let loadAttempt = 0;

function loadSearch() {
  if (serviceRequest) return serviceRequest;
  if (!amapConfigured) return Promise.reject(new Error('高德地点搜索尚未配置'));
  serviceRequest = new Promise((resolve, reject) => {
    window._AMapSecurityConfig = { serviceHost };
    const script = document.createElement('script');
    const url = new URL('https://webapi.amap.com/maps');
    const callback = 'footprintsAmapReady' + ++loadAttempt;
    url.search = new URLSearchParams({ v: '2.0', key, callback });
    script.src = url.href;
    const cleanup = () => {
      clearTimeout(timeout);
      delete window[callback];
    };
    const fail = () => {
      cleanup();
      script.remove();
      reject(new Error('高德地点搜索服务加载失败'));
    };
    const timeout = setTimeout(fail, 8000);
    script.onerror = fail;
    window[callback] = () => {
      const amap = window.AMap;
      if (!amap?.plugin) return fail();
      amap.plugin(['AMap.AutoComplete', 'AMap.PlaceSearch'], () => {
        if (!amap.AutoComplete || !amap.PlaceSearch) return fail();
        try {
          const services = { suggestions: new amap.AutoComplete(), places: new amap.PlaceSearch() };
          cleanup();
          resolve(services);
        } catch {
          fail();
        }
      });
    };
    document.head.append(script);
  }).catch(error => {
    serviceRequest = undefined;
    throw error;
  });
  return serviceRequest;
}

function request(run) {
  return new Promise((resolve, reject) => {
    const fail = () => reject(new Error('高德地点搜索暂不可用'));
    const timeout = setTimeout(fail, 8000);
    try {
      run((status, result) => {
        clearTimeout(timeout);
        if (status === 'no_data') resolve(null);
        else if (status === 'complete') resolve(result);
        else fail();
      });
    } catch {
      clearTimeout(timeout);
      fail();
    }
  });
}

function normalizePlace(place) {
  const location = place.location;
  const point = typeof location === 'string' && location.includes(',')
    ? location.split(',').map(value => value.trim() ? Number(value) : NaN)
    : Array.isArray(location) ? location : [location?.lng, location?.lat];
  const type = String(place.typecode || place.type || '');
  const attraction = /(?:^|[|,])11\d{4}(?:$|[|,])|风景名胜/.test(type);
  return {
    ...place,
    point: isMapPoint(point) ? point : undefined,
    attraction: attraction ? true : /\d{6}|[\u3400-\u9fff]/.test(type) ? false : undefined,
  };
}

export async function searchPlaces(query, signal) {
  const { suggestions } = await loadSearch();
  signal.throwIfAborted();
  const result = await request(callback => suggestions.search(query, callback));
  return (result?.tips || []).filter(Boolean).map(normalizePlace);
}

export async function getPlaceDetails(id) {
  const { places } = await loadSearch();
  const result = await request(callback => places.getDetails(id, callback));
  const place = result?.poiList?.pois?.[0];
  return place ? normalizePlace(place) : undefined;
}
