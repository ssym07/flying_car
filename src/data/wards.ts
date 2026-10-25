// PLATEAU 建築物モデル（2025）の 3D Tiles 配信 URL。東京23区。
// データカタログ API（https://api.plateauview.mlit.go.jp/datacatalog/plateau-datasets）から作成。
// どの区も軽い LOD1（LOD1 が無い台東区はテクスチャ無し LOD2）に外壁テンプレートを貼る。
// kind: 'lod2-texture' にすると配信データのテクスチャのまま表示する（1区で100MB超と重い）。

export interface Ward {
  /** 市区町村コード（国土地理院の逆ジオコーダの muniCd と同じ） */
  code: string;
  name: string;
  kind: 'lod1' | 'lod2-texture' | 'lod2-no-texture';
  url: string;
}

export const WARDS: Ward[] = [
  { code: '13101', name: '千代田区', kind: 'lod1', url: 'https://assets.cms.plateau.reearth.io/assets/3f/e07412-5455-40c0-9f64-2ac43086a209/13101_chiyoda-ku_pref_2025_citygml_1_op_bldg_3dtiles_13101_chiyoda-ku_lod1/tileset.json' },
  // テクスチャ付き LOD2（重い・写真の質感）: { code: '13101', name: '千代田区', kind: 'lod2-texture', url: 'https://assets.cms.plateau.reearth.io/assets/28/07d0a1-b6be-46ef-bd87-4f0683b5ef6e/13101_chiyoda-ku_pref_2025_citygml_1_op_bldg_3dtiles_13101_chiyoda-ku_lod2/tileset.json' },
  { code: '13102', name: '中央区', kind: 'lod1', url: 'https://assets.cms.plateau.reearth.io/assets/cf/ccca91-acfc-4e01-b114-a56f63c2cd6b/13102_chuo-ku_pref_2025_citygml_1_op_bldg_3dtiles_13102_chuo-ku_lod1/tileset.json' },
  { code: '13103', name: '港区', kind: 'lod1', url: 'https://assets.cms.plateau.reearth.io/assets/71/15d8f0-c4e1-4866-8df4-e66cac71c248/13103_minato-ku_pref_2025_citygml_1_op_bldg_3dtiles_13103_minato-ku_lod1/tileset.json' },
  { code: '13104', name: '新宿区', kind: 'lod1', url: 'https://assets.cms.plateau.reearth.io/assets/bd/858f21-55cb-46da-afcf-885d44eee90f/13104_shinjuku-ku_pref_2025_citygml_1_op_bldg_3dtiles_13104_shinjuku-ku_lod1/tileset.json' },
  { code: '13105', name: '文京区', kind: 'lod1', url: 'https://assets.cms.plateau.reearth.io/assets/2a/2e5263-b983-44aa-838d-ad12a80e438a/13105_bunkyo-ku_pref_2025_citygml_1_op_bldg_3dtiles_13105_bunkyo-ku_lod1/tileset.json' },
  { code: '13106', name: '台東区', kind: 'lod1', url: 'https://assets.cms.plateau.reearth.io/assets/98/c5ff8d-d6b4-40fb-8ef9-fcca1407f9c0/13106_taito-ku_city_2025_citygml_1_op_bldg_3dtiles_lod1/tileset.json' },
  { code: '13107', name: '墨田区', kind: 'lod1', url: 'https://assets.cms.plateau.reearth.io/assets/23/84525d-1d36-42f8-8e5d-39a0af203f51/13107_sumida-ku_pref_2025_citygml_1_op_bldg_3dtiles_13107_sumida-ku_lod1/tileset.json' },
  { code: '13108', name: '江東区', kind: 'lod1', url: 'https://assets.cms.plateau.reearth.io/assets/4d/ba6c87-3dd2-496e-8091-a1aa32bb83cc/13108_koto-ku_pref_2025_citygml_1_op_bldg_3dtiles_13108_koto-ku_lod1/tileset.json' },
  { code: '13109', name: '品川区', kind: 'lod1', url: 'https://assets.cms.plateau.reearth.io/assets/27/58e4c5-4b15-4b44-a819-a97fe8842c2d/13109_shinagawa-ku_pref_2025_citygml_1_op_bldg_3dtiles_13109_shinagawa-ku_lod1/tileset.json' },
  { code: '13110', name: '目黒区', kind: 'lod1', url: 'https://assets.cms.plateau.reearth.io/assets/59/ce8691-c4dc-4c91-bd9f-633b26e2f09c/13110_meguro-ku_pref_2025_citygml_1_op_bldg_3dtiles_13110_meguro-ku_lod1/tileset.json' },
  { code: '13111', name: '大田区', kind: 'lod1', url: 'https://assets.cms.plateau.reearth.io/assets/d6/7a1d59-04c2-462f-8bc4-0aacdb0a3cab/13111_ota-ku_pref_2025_citygml_1_op_bldg_3dtiles_13111_ota-ku_lod1/tileset.json' },
  { code: '13112', name: '世田谷区', kind: 'lod1', url: 'https://assets.cms.plateau.reearth.io/assets/36/586abf-16c7-4a6e-a802-5a85fdc34554/13112_setagaya-ku_pref_2025_citygml_1_op_bldg_3dtiles_13112_setagaya-ku_lod1/tileset.json' },
  { code: '13113', name: '渋谷区', kind: 'lod1', url: 'https://assets.cms.plateau.reearth.io/assets/cf/26763c-faae-41b3-b110-2a4dd602f250/13113_shibuya-ku_pref_2025_citygml_1_op_bldg_3dtiles_13113_shibuya-ku_lod1/tileset.json' },
  { code: '13114', name: '中野区', kind: 'lod1', url: 'https://assets.cms.plateau.reearth.io/assets/00/0bafbd-0652-4f11-ab1f-ca88d81a98a7/13114_nakano-ku_pref_2025_citygml_1_op_bldg_3dtiles_13114_nakano-ku_lod1/tileset.json' },
  { code: '13115', name: '杉並区', kind: 'lod1', url: 'https://assets.cms.plateau.reearth.io/assets/fe/edc7a4-9189-4579-ad90-3648f112f275/13115_suginami-ku_city_2025_citygml_1_op_bldg_3dtiles_13115_suginami-ku_lod1/tileset.json' },
  { code: '13116', name: '豊島区', kind: 'lod1', url: 'https://assets.cms.plateau.reearth.io/assets/0a/f58fff-4c1a-429e-a626-efb32d7423ed/13116_toshima-ku_pref_2025_citygml_1_op_bldg_3dtiles_13116_toshima-ku_lod1/tileset.json' },
  { code: '13117', name: '北区', kind: 'lod1', url: 'https://assets.cms.plateau.reearth.io/assets/ee/037a59-2e97-441b-b5bc-5744fac3b327/13117_kita-ku_pref_2025_citygml_1_op_bldg_3dtiles_13117_kita-ku_lod1/tileset.json' },
  { code: '13118', name: '荒川区', kind: 'lod1', url: 'https://assets.cms.plateau.reearth.io/assets/78/8d45f8-5c53-4150-88ec-4ea19d2bf34b/13118_arakawa-ku_pref_2025_citygml_1_op_bldg_3dtiles_13118_arakawa-ku_lod1/tileset.json' },
  { code: '13119', name: '板橋区', kind: 'lod1', url: 'https://assets.cms.plateau.reearth.io/assets/34/ef93b7-ac60-45f8-84be-b7985d8c06fb/13119_itabashi-ku_pref_2025_citygml_1_op_bldg_3dtiles_13119_itabashi-ku_lod1/tileset.json' },
  { code: '13120', name: '練馬区', kind: 'lod1', url: 'https://assets.cms.plateau.reearth.io/assets/77/4ec481-2b86-4654-a600-95a52471d540/13120_nerima-ku_pref_2025_citygml_1_op_bldg_3dtiles_13120_nerima-ku_lod1/tileset.json' },
  { code: '13121', name: '足立区', kind: 'lod1', url: 'https://assets.cms.plateau.reearth.io/assets/72/13a360-c4cd-41e6-bcf8-7064c1090069/13121_adachi-ku_pref_2025_citygml_1_op_bldg_3dtiles_13121_adachi-ku_lod1/tileset.json' },
  { code: '13122', name: '葛飾区', kind: 'lod1', url: 'https://assets.cms.plateau.reearth.io/assets/a6/2a8fdb-8b94-4216-8350-b8be0dad54d4/13122_katsushika-ku_pref_2025_citygml_1_op_bldg_3dtiles_13122_katsushika-ku_lod1/tileset.json' },
  { code: '13123', name: '江戸川区', kind: 'lod1', url: 'https://assets.cms.plateau.reearth.io/assets/47/58c2c1-5c6f-492a-b887-d00276dd2703/13123_edogawa-ku_pref_2025_citygml_1_op_bldg_3dtiles_13123_edogawa-ku_lod1/tileset.json' },
];
