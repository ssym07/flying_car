import type { StyleSpecification, ExpressionSpecification } from 'maplibre-gl';

/**
 * ミニマップの地図の見た目：白地の簡略図（Google マップのような配色）。
 * 地図のデータは国土地理院の最適化ベクトルタイル（optimal_bvmap、PMTiles）。
 * 描くのは 地面・水・建物・道路（種別で色と太さ）・地上の鉄道・地名（町名・公園・施設）だけ。
 * 等高線・境界線・送電線・地下の鉄道は描かない。駅名はゲームの駅データを別に重ねる（minimap.ts）
 */
export const BVMAP_URL = 'pmtiles://https://cyberjapandata.gsi.go.jp/xyz/optimal_bvmap-v1/optimal_bvmap-v1.pmtiles';
const GLYPHS = 'https://gsi-cyberjapan.github.io/optimal_bvmap/glyphs/{fontstack}/{range}.pbf';
export const FONT = ['NotoSansJP-Regular'];

export const COLORS = {
  land: '#f4f3ef',
  water: '#aadaff',
  waterText: '#4a7fb5',
  building: '#e7e5e1',
  buildingEdge: '#d8d5cf',
  motorway: '#f7c86a',
  motorwayEdge: '#e2a640',
  national: '#fde7a0',
  nationalEdge: '#eac661',
  road: '#ffffff',
  roadEdge: '#d9d7d2',
  rail: '#9da3aa',
  text: '#5f6368',
  park: '#3f8f4a',
  station: '#3c4043',
};

/** 高速道路（有料の自動車専用道路を含む） */
const isMotorway: ExpressionSpecification = [
  'any',
  ['==', ['get', 'vt_motorway'], 1],
  ['==', ['get', 'vt_rdctg'], '高速自動車国道等'],
];
const isNational: ExpressionSpecification = ['==', ['get', 'vt_rdctg'], '国道'];
const isPrefectural: ExpressionSpecification = ['==', ['get', 'vt_rdctg'], '都道府県道'];
/** トンネル（薄く描く）・階段や庭園路（描かない） */
const TUNNEL = [2703, 2713, 2723, 2733];
const SKIP_ROAD = [2704, 2714, 2724, 2731, 2732, 2733, 2734];

/** 道路の太さ (px)：ズーム 12 で base、ズームが 1 上がるごとにおおよそ倍（ズーム 18 まで） */
function roadWidth(extra: number): ExpressionSpecification {
  const base: ExpressionSpecification = [
    'case',
    isMotorway,
    3,
    isNational,
    2.6,
    isPrefectural,
    2.1,
    [
      'match',
      ['get', 'vt_rnkwidth'],
      '19.5m以上',
      2.1,
      '13m-19.5m未満',
      1.7,
      '5.5m-13m未満',
      1.1,
      0.6,
    ],
  ];
  return [
    'interpolate',
    ['exponential', 1.6],
    ['zoom'],
    12,
    ['+', ['*', base, 0.45], extra * 0.5],
    15,
    ['+', ['*', base, 2], extra],
    18,
    ['+', ['*', base, 8], extra * 1.5],
  ];
}

/** 細い道はズームを上げてから出す（引いた時に網目にならないように） */
const roadVisible: ExpressionSpecification = [
  'all',
  ['!', ['in', ['get', 'vt_code'], ['literal', SKIP_ROAD]]],
  [
    'any',
    isMotorway,
    isNational,
    isPrefectural,
    ['>=', ['zoom'], ['match', ['get', 'vt_rnkwidth'], '19.5m以上', 12, '13m-19.5m未満', 13, '5.5m-13m未満', 14, 15]],
  ],
];

const roadColor = (edge: boolean): ExpressionSpecification => [
  'case',
  isMotorway,
  edge ? COLORS.motorwayEdge : COLORS.motorway,
  isNational,
  edge ? COLORS.nationalEdge : COLORS.national,
  edge ? COLORS.roadEdge : COLORS.road,
];

const roadOpacity: ExpressionSpecification = ['case', ['in', ['get', 'vt_code'], ['literal', TUNNEL]], 0.35, 1];

/** 道路：縁取り → 本体の順に、細い道 → 太い道 → 高速の順で重ねる（vt_drworder） */
function roadLayers(): StyleSpecification['layers'] {
  return (['edge', 'fill'] as const).map((part) => ({
    id: `road-${part}`,
    type: 'line',
    source: 'v',
    'source-layer': 'RdCL',
    minzoom: 10,
    filter: roadVisible,
    layout: {
      'line-join': 'round',
      'line-cap': 'round',
      'line-sort-key': ['case', isMotorway, 1000, isNational, 900, isPrefectural, 800, ['get', 'vt_drworder']],
    },
    paint: {
      'line-color': roadColor(part === 'edge'),
      'line-width': roadWidth(part === 'edge' ? 1.6 : 0),
      'line-opacity': roadOpacity,
    },
  }));
}

/** 地名：町名（210）・公園（531 など）・施設（6xx）。駅（422）と路線名（421）は出さない */
const ANNO_TOWN = [210, 220];
const ANNO_PARK = [531, 532, 533, 534];
const ANNO_PLACE = [110, 120, 130, 140, 311, 312, 314, 315, 316];

export function minimapStyle(): StyleSpecification {
  return {
    version: 8,
    glyphs: GLYPHS,
    sources: {
      v: { type: 'vector', tiles: [`${BVMAP_URL}/{z}/{x}/{y}`], minzoom: 4, maxzoom: 16 },
    },
    layers: [
      { id: 'land', type: 'background', paint: { 'background-color': COLORS.land } },
      {
        id: 'water',
        type: 'fill',
        source: 'v',
        'source-layer': 'WA',
        paint: { 'fill-color': COLORS.water },
      },
      {
        id: 'building',
        type: 'fill',
        source: 'v',
        'source-layer': 'BldA',
        minzoom: 14.5,
        paint: {
          'fill-color': COLORS.building,
          'fill-outline-color': COLORS.buildingEdge,
          'fill-opacity': ['interpolate', ['linear'], ['zoom'], 14.5, 0, 15.5, 1],
        },
      },
      ...roadLayers(),
      {
        id: 'rail',
        type: 'line',
        source: 'v',
        'source-layer': 'RailCL',
        minzoom: 9,
        filter: [
          'all',
          ['!', ['in', ['get', 'vt_railstate'], ['literal', ['トンネル', '地下', '雪覆い']]]],
          ['!', ['in', ['get', 'vt_rtcode'], ['literal', ['地下鉄', '索道', '側線']]]],
        ],
        paint: {
          'line-color': COLORS.rail,
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.8, 15, ['match', ['get', 'vt_rtcode'], 'JR', 2.4, 1.8], 18, 4],
        },
      },
      {
        id: 'anno-park',
        type: 'symbol',
        source: 'v',
        'source-layer': 'Anno',
        minzoom: 13,
        filter: ['all', ['==', ['geometry-type'], 'Point'], ['in', ['get', 'vt_code'], ['literal', ANNO_PARK]]],
        layout: {
          'text-field': ['get', 'vt_text'],
          'text-font': FONT,
          'text-size': 11,
          'text-max-width': 7,
        },
        paint: { 'text-color': COLORS.park, 'text-halo-color': '#ffffff', 'text-halo-width': 1.4 },
      },
      {
        id: 'anno-place',
        type: 'symbol',
        source: 'v',
        'source-layer': 'Anno',
        filter: [
          'all',
          ['==', ['geometry-type'], 'Point'],
          [
            'any',
            ['in', ['get', 'vt_code'], ['literal', ANNO_PLACE]],
            ['all', ['in', ['get', 'vt_code'], ['literal', ANNO_TOWN]], ['>=', ['zoom'], 13.5]],
            ['all', ['>=', ['get', 'vt_code'], 600], ['<', ['get', 'vt_code'], 700], ['>=', ['zoom'], 15.5]],
          ],
        ],
        layout: {
          'text-field': ['get', 'vt_text'],
          'text-font': FONT,
          'text-size': ['case', ['in', ['get', 'vt_code'], ['literal', ANNO_TOWN]], 10.5, 11.5],
          'text-max-width': 8,
        },
        paint: { 'text-color': COLORS.text, 'text-halo-color': '#ffffff', 'text-halo-width': 1.4 },
      },
    ],
  };
}
