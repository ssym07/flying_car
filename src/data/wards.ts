// PLATEAU 建築物モデルの 3D Tiles 配信 URL。東京23区（2025）と、横浜市・川崎市の各区。
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
  // 横浜市（18区・2024）・川崎市（7区・2022）
  { code: '14101', name: '横浜市鶴見区', kind: 'lod1', url: 'https://assets.cms.plateau.reearth.io/assets/eb/368b4e-eb03-45dd-8fd4-f59b5faeb44b/14100_yokohama-shi_city_2024_citygml_2_op_bldg_3dtiles_14101_tsurumi-ku_lod1/tileset.json' },
  { code: '14102', name: '横浜市神奈川区', kind: 'lod1', url: 'https://assets.cms.plateau.reearth.io/assets/fa/12701b-a5ed-454a-9693-a7b5263596b4/14100_yokohama-shi_city_2024_citygml_2_op_bldg_3dtiles_14102_kanagawa-ku_lod1/tileset.json' },
  { code: '14103', name: '横浜市西区', kind: 'lod1', url: 'https://assets.cms.plateau.reearth.io/assets/ad/5fd83a-161b-4a01-a666-a3e8c1c23759/14100_yokohama-shi_city_2024_citygml_2_op_bldg_3dtiles_14103_nishi-ku_lod1/tileset.json' },
  { code: '14104', name: '横浜市中区', kind: 'lod1', url: 'https://assets.cms.plateau.reearth.io/assets/48/507079-4d87-45fb-8941-253f3bd1c51e/14100_yokohama-shi_city_2024_citygml_2_op_bldg_3dtiles_14104_naka-ku_lod1/tileset.json' },
  { code: '14105', name: '横浜市南区', kind: 'lod1', url: 'https://assets.cms.plateau.reearth.io/assets/1b/fc666f-c035-4af6-afa0-ffe0e8861643/14100_yokohama-shi_city_2024_citygml_2_op_bldg_3dtiles_14105_minami-ku_lod1/tileset.json' },
  { code: '14106', name: '横浜市保土ケ谷区', kind: 'lod1', url: 'https://assets.cms.plateau.reearth.io/assets/f9/408540-ac01-4d51-929d-b25ad7ad7c1f/14100_yokohama-shi_city_2024_citygml_2_op_bldg_3dtiles_14106_hodogaya-ku_lod1/tileset.json' },
  { code: '14107', name: '横浜市磯子区', kind: 'lod1', url: 'https://assets.cms.plateau.reearth.io/assets/87/d45a7d-3ebf-4504-886c-cf7459fe1a83/14100_yokohama-shi_city_2024_citygml_2_op_bldg_3dtiles_14107_isogo-ku_lod1/tileset.json' },
  { code: '14108', name: '横浜市金沢区', kind: 'lod1', url: 'https://assets.cms.plateau.reearth.io/assets/9f/4616c4-ec75-4c0e-b3e1-c4db09d427cf/14100_yokohama-shi_city_2024_citygml_2_op_bldg_3dtiles_14108_kanazawa-ku_lod1/tileset.json' },
  { code: '14109', name: '横浜市港北区', kind: 'lod1', url: 'https://assets.cms.plateau.reearth.io/assets/1d/b1355d-4206-42f2-b75a-4b3831af1ac6/14100_yokohama-shi_city_2024_citygml_2_op_bldg_3dtiles_14109_kohoku-ku_lod1/tileset.json' },
  { code: '14110', name: '横浜市戸塚区', kind: 'lod1', url: 'https://assets.cms.plateau.reearth.io/assets/db/aea506-216d-4f08-9352-e136c1e1467c/14100_yokohama-shi_city_2024_citygml_2_op_bldg_3dtiles_14110_totsuka-ku_lod1/tileset.json' },
  { code: '14111', name: '横浜市港南区', kind: 'lod1', url: 'https://assets.cms.plateau.reearth.io/assets/5a/157715-1458-4408-9823-0fb70c91856a/14100_yokohama-shi_city_2024_citygml_2_op_bldg_3dtiles_14111_konan-ku_lod1/tileset.json' },
  { code: '14112', name: '横浜市旭区', kind: 'lod1', url: 'https://assets.cms.plateau.reearth.io/assets/a8/b75061-0f14-4459-96bc-911aa0b61213/14100_yokohama-shi_city_2024_citygml_2_op_bldg_3dtiles_14112_asahi-ku_lod1/tileset.json' },
  { code: '14113', name: '横浜市緑区', kind: 'lod1', url: 'https://assets.cms.plateau.reearth.io/assets/15/56c93f-7449-4716-ac37-175178da2e2f/14100_yokohama-shi_city_2024_citygml_2_op_bldg_3dtiles_14113_midori-ku_lod1/tileset.json' },
  { code: '14114', name: '横浜市瀬谷区', kind: 'lod1', url: 'https://assets.cms.plateau.reearth.io/assets/40/45bd26-1a54-4981-96a3-8522309d8c93/14100_yokohama-shi_city_2024_citygml_2_op_bldg_3dtiles_14114_seya-ku_lod1/tileset.json' },
  { code: '14115', name: '横浜市栄区', kind: 'lod1', url: 'https://assets.cms.plateau.reearth.io/assets/2f/feca6f-b80f-4b79-939a-1be8aabce2c0/14100_yokohama-shi_city_2024_citygml_2_op_bldg_3dtiles_14115_sakae-ku_lod1/tileset.json' },
  { code: '14116', name: '横浜市泉区', kind: 'lod1', url: 'https://assets.cms.plateau.reearth.io/assets/82/51fc14-4dcf-4ff3-97b3-0d0845240323/14100_yokohama-shi_city_2024_citygml_2_op_bldg_3dtiles_14116_izumi-ku_lod1/tileset.json' },
  { code: '14117', name: '横浜市青葉区', kind: 'lod1', url: 'https://assets.cms.plateau.reearth.io/assets/6e/8b2316-0304-4de5-b465-c1789c3a0add/14100_yokohama-shi_city_2024_citygml_2_op_bldg_3dtiles_14117_aoba-ku_lod1/tileset.json' },
  { code: '14118', name: '横浜市都筑区', kind: 'lod1', url: 'https://assets.cms.plateau.reearth.io/assets/12/d3b4ec-fe21-4fdc-8509-126df613ba0d/14100_yokohama-shi_city_2024_citygml_2_op_bldg_3dtiles_14118_tsuzuki-ku_lod1/tileset.json' },
  { code: '14131', name: '川崎市川崎区', kind: 'lod1', url: 'https://assets.cms.plateau.reearth.io/assets/ee/696401-0a95-44b8-ba7b-61dfe68e07aa/14130_kawasaki-shi_city_2022_citygml_4_op_bldg_3dtiles_14131_kawasaki-ku_lod1/tileset.json' },
  { code: '14132', name: '川崎市幸区', kind: 'lod1', url: 'https://assets.cms.plateau.reearth.io/assets/a2/f76be3-baff-42e6-8a77-a82dfeab6b16/14130_kawasaki-shi_city_2022_citygml_4_op_bldg_3dtiles_14132_saiwai-ku_lod1/tileset.json' },
  { code: '14133', name: '川崎市中原区', kind: 'lod1', url: 'https://assets.cms.plateau.reearth.io/assets/60/ec803d-7bbd-4574-b6f2-809ffc580419/14130_kawasaki-shi_city_2022_citygml_4_op_bldg_3dtiles_14133_nakahara-ku_lod1/tileset.json' },
  { code: '14134', name: '川崎市高津区', kind: 'lod1', url: 'https://assets.cms.plateau.reearth.io/assets/16/003fe8-d709-469d-bf2f-d0233cfad231/14130_kawasaki-shi_city_2022_citygml_4_op_bldg_3dtiles_14134_takatsu-ku_lod1/tileset.json' },
  { code: '14135', name: '川崎市多摩区', kind: 'lod1', url: 'https://assets.cms.plateau.reearth.io/assets/91/53db04-831f-4d05-a906-4d0419201285/14130_kawasaki-shi_city_2022_citygml_4_op_bldg_3dtiles_14135_tama-ku_lod1/tileset.json' },
  { code: '14136', name: '川崎市宮前区', kind: 'lod1', url: 'https://assets.cms.plateau.reearth.io/assets/60/33ccc8-8727-475e-946e-88c6020cc2f6/14130_kawasaki-shi_city_2022_citygml_4_op_bldg_3dtiles_14136_miyamae-ku_lod1/tileset.json' },
  { code: '14137', name: '川崎市麻生区', kind: 'lod1', url: 'https://assets.cms.plateau.reearth.io/assets/de/d9ebc6-0fe4-4cb1-94b0-1affded44d42/14130_kawasaki-shi_city_2022_citygml_4_op_bldg_3dtiles_14137_asao-ku_lod1/tileset.json' },
];
