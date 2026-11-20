import { coordinates, isMapPoint } from './map.js';

const normalize = value => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const shortAreaName = name => name.replace(/(特别行政区|壮族自治区|回族自治区|维吾尔自治区|自治区|自治州|地区|省|市|区|县|盟|旗)$/, '');
const shortScenicName = name => name.replace(/(风景名胜区|风景旅游区|风景区|旅游景区|旅游区|景区)$/, '');

function indexPlace(place, parents, aliases) {
  const label = normalize(place.label);
  const names = [...new Set([label, ...aliases.map(normalize)])].filter(Boolean);
  let prefixes = [''];
  for (const parent of parents) {
    const forms = [...new Set([parent, shortAreaName(parent)].map(normalize))];
    prefixes = ['', ...prefixes.flatMap(prefix => forms.map(form => prefix + form))];
  }
  return {
    ...place,
    context: parents.join(' · '),
    searchLabel: label,
    searchNames: names,
    qualifiedNames: prefixes.slice(1).flatMap(prefix => names.map(name => prefix + name)),
  };
}

export function buildPlaceIndex(byId, catalog, markedAttractions, canMark) {
  const areaNames = codes => [...new Set(codes)].map(code => byId[code]?.name).filter(Boolean);
  const areas = Object.values(byId).filter(area => area.level === 'province' || canMark(area.adcode)).map(area =>
    indexPlace({ key: area.adcode, id: area.adcode, label: area.name }, areaNames(area.acroutes), [shortAreaName(area.name)])
  );
  const points = (catalog?.places || []).flatMap(place => {
    if (!isMapPoint(place.location)) return [];
    // The first branch holds the representative point when a scenic area spans more than one city.
    const candidates = place.areas.filter(canMark).map(code => byId[code]);
    const first = candidates[0];
    if (!first) return [];
    const area = candidates.filter(candidate => candidate.adcode === first.adcode || candidate.acroutes.includes(first.adcode)).at(-1);
    const point = (place.coordinateSystem || catalog.coordinateSystem) === 'WGS84'
      ? coordinates(...place.location)
      : place.location;
    return [indexPlace(
      { key: 'catalog:' + place.id, id: area.adcode, label: place.name, point, isPoint: true },
      areaNames([...area.acroutes, area.adcode]),
      [shortScenicName(place.name), ...(place.aliases || [])],
    )];
  });
  const savedPoints = markedAttractions.flatMap(({ id, name, point, areas }) => {
    if (id.startsWith('catalog:') || !isMapPoint(point)) return [];
    const areaId = areas.filter(Boolean).at(-1);
    if (!canMark(areaId)) return [];
    return [indexPlace({ key: id, id: areaId, label: name, point, isPoint: true }, areaNames(areas), [shortScenicName(name)])];
  });
  return [...areas, ...savedPoints, ...points];
}

export function findPlaces(index, query) {
  const keyword = normalize(query);
  if (!keyword) return [];
  const matches = [];
  for (const place of index) {
    const { searchLabel, searchNames, qualifiedNames } = place;
    let rank;
    if (searchLabel === keyword) rank = 0;
    else if (searchNames.includes(keyword)) rank = 1;
    else if (qualifiedNames.includes(keyword)) rank = 2;
    else if (searchNames.some(name => name.startsWith(keyword))) rank = 3;
    else if (searchNames.some(name => name.includes(keyword))) rank = 4;
    else if (qualifiedNames.some(name => name.includes(keyword))) rank = 5;
    else continue;
    matches.push({ place, rank });
  }
  return matches.sort((a, b) => a.rank - b.rank).map(({ place }) => place);
}
