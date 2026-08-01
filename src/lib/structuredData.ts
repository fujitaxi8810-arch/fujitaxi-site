const siteUrl = 'https://fujitaxi-minamisoma.com';

export const localBusinessSchema = {
  '@context': 'https://schema.org',
  '@type': ['LocalBusiness', 'TaxiService'],
  name: '有限会社 富士タクシー',
  alternateName: '富士タクシー 南相馬',
  description: '南相馬市小高区・原町区を拠点とするタクシー会社。創業50年以上、スクールタクシー・デマンド乗合・観光タクシー・ジャンボタクシーを運行。',
  url: siteUrl,
  telephone: '0244-44-2543',
  email: 'fuji-taxi.odaka@white.plala.or.jp',
  image: `${siteUrl}/images/og-default.jpg`,
  logo: `${siteUrl}/images/logo-fuji-taxi.jpg`,
  foundingDate: '1971',
  priceRange: '¥700〜',
  currenciesAccepted: 'JPY',
  paymentAccepted: '現金, クレジットカード, PayPay, 交通系IC, 電子マネー, JTBタクシーチケット',
  openingHoursSpecification: {
    '@type': 'OpeningHoursSpecification',
    dayOfWeek: [
      'Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday','PublicHolidays'
    ],
    opens: '07:00',
    closes: '24:00',
  },
  address: [
    {
      '@type': 'PostalAddress',
      addressCountry: 'JP',
      postalCode: '979-2124',
      addressRegion: '福島県',
      addressLocality: '南相馬市小高区',
      streetAddress: '本町一丁目57番地',
      name: '本社',
    },
    {
      '@type': 'PostalAddress',
      addressCountry: 'JP',
      postalCode: '975-0037',
      addressRegion: '福島県',
      addressLocality: '南相馬市原町区',
      streetAddress: '北原字本屋敷181番地1',
      name: '原町待機所',
    },
  ],
  geo: {
    '@type': 'GeoCoordinates',
    latitude: 37.5491,
    longitude: 141.0078,
  },
  areaServed: {
    '@type': 'AdministrativeArea',
    name: '福島県南相馬市',
  },
  hasOfferCatalog: {
    '@type': 'OfferCatalog',
    name: 'タクシーサービス一覧',
    itemListElement: [
      { '@type': 'Offer', itemOffered: { '@type': 'Service', name: '一般乗用タクシー', description: '初乗り700円〜' } },
      { '@type': 'Offer', itemOffered: { '@type': 'Service', name: 'ジャンボタクシー（最大9名）', description: '初乗り980円〜、貸切対応' } },
      { '@type': 'Offer', itemOffered: { '@type': 'Service', name: 'デマンドタクシー（乗合）', description: '小高区内・原町区間の乗合運行' } },
      { '@type': 'Offer', itemOffered: { '@type': 'Service', name: 'スクールタクシー', description: '小高区スクール送迎・毎日運行' } },
    ],
  },
  sameAs: [
    'https://www.instagram.com/fuji_taxi442543/',
    'https://www.tiktok.com/@fujitaxi8810',
    'https://line.me/R/ti/p/@580lzpne',
    'https://www.google.com/maps/place/%E3%88%B2%E5%AF%8C%E5%A3%AB%E3%82%BF%E3%82%AF%E3%82%B7%E3%83%BC/data=!4m7!3m6!1s0x6020953600cf6d2b:0x54fa84d84b926304!8m2!3d37.5638552!4d140.9911752!16s%2Fg%2F11f0_b2t0_!19sChIJK23PADaVIGARBGOSS9iE-lQ',
    'https://www.google.com/maps/place/%28%E6%9C%89%29%E5%AF%8C%E5%A3%AB%E3%82%BF%E3%82%AF%E3%82%B7%E3%83%BC%E5%8E%9F%E7%94%BA%E5%BE%85%E6%A9%9F%E6%89%80+%E5%8D%97%E7%9B%B8%E9%A6%AC%E5%B8%82/data=!4m7!3m6!1s0x6020954451ace2b9:0xcb8e83fef1b7b3e8!8m2!3d37.6272827!4d140.9850973!16s%2Fg%2F11rqwl4vbq!19sChIJueKsUUSVIGAR6LO38f6Djss',
  ],
};
