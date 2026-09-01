// Canonical business identity for schema.org JSON-LD.
// This is the single source of truth for the PaintingContractor node.
// Server-rendered pages import BUSINESS_LD_SCRIPT; static HTML files
// (public/index.html, public/lessons.html) inline the identical block —
// regenerate them with `node server/business-schema.js` if this changes.

export const BUSINESS_LD = {
  '@context': 'https://schema.org',
  '@type': 'PaintingContractor',
  '@id': 'https://specialtyhomepainting.com/#business',
  name: 'Specialty Home Painting',
  image: 'https://specialtyhomepainting.com/logo.png',
  logo: 'https://specialtyhomepainting.com/logo.png',
  url: 'https://specialtyhomepainting.com/',
  telephone: '+1-904-514-7016',
  email: 'issam@specialtyhomepainting.com',
  priceRange: '$',
  founder: { '@type': 'Person', name: 'Issam' },
  description:
    'Interior painting and specialty repair in Orlando, FL — door restoration and refinishing, drywall repair, and precision trim and ceiling painting. We fix problems before we paint over them.',
  // No street address by choice — service-area business, not a storefront.
  address: {
    '@type': 'PostalAddress',
    addressLocality: 'Orlando',
    addressRegion: 'FL',
    postalCode: '32827',
    addressCountry: 'US',
  },
  areaServed: {
    '@type': 'GeoCircle',
    name: 'Lake Nona and surrounding areas',
    // Rounded to the Lake Nona area — deliberately not the exact home location.
    geoMidpoint: { '@type': 'GeoCoordinates', latitude: 28.38, longitude: -81.25 },
    geoRadius: 40000,
  },
  openingHoursSpecification: [
    {
      '@type': 'OpeningHoursSpecification',
      dayOfWeek: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
      opens: '08:00',
      closes: '18:00',
    },
  ],
  sameAs: ['https://www.facebook.com/profile.php?id=61572034713934'],
  makesOffer: [
    { '@type': 'Offer', itemOffered: { '@type': 'Service', name: 'Interior painting (walls & ceilings)' } },
    { '@type': 'Offer', itemOffered: { '@type': 'Service', name: 'Interior door refinishing & restoration' } },
    { '@type': 'Offer', itemOffered: { '@type': 'Service', name: 'French door restoration' } },
    { '@type': 'Offer', itemOffered: { '@type': 'Service', name: 'Exterior & front-entry door refinishing' } },
    { '@type': 'Offer', itemOffered: { '@type': 'Service', name: 'Trim, baseboards & crown molding painting' } },
    { '@type': 'Offer', itemOffered: { '@type': 'Service', name: 'Window woodwork & trim painting' } },
    { '@type': 'Offer', itemOffered: { '@type': 'Service', name: 'Banister & railing refinishing' } },
    { '@type': 'Offer', itemOffered: { '@type': 'Service', name: 'Drywall repair' } },
  ],
};

// Pretty-printed inner JSON (2-space indent), matching what the static
// HTML files inline so all three pages carry a byte-identical node.
export const BUSINESS_LD_JSON = JSON.stringify(BUSINESS_LD, null, 2);

// Full <script> tag for server-rendered pages.
export const BUSINESS_LD_SCRIPT =
  '<script type="application/ld+json">\n' + BUSINESS_LD_JSON + '\n</script>';

// Run directly (`node server/business-schema.js`) to print the inline
// block for pasting into the static HTML files.
if (import.meta.url === `file://${process.argv[1]}`) {
  process.stdout.write(BUSINESS_LD_SCRIPT + '\n');
}
