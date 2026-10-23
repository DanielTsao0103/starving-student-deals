/** Fixed vocabulary from docs/CUISINES.md; no business data is bundled here. */
export const REGIONS = {
  "Asian": [
    "Chinese",
    "Japanese",
    "Korean",
    "Thai",
    "Vietnamese",
    "Filipino",
    "Indian",
    "Nepali",
    "Pan-Asian / Asian fusion"
  ],
  "European": [
    "Italian",
    "Greek",
    "French",
    "Spanish",
    "German",
    "British",
    "Eastern European"
  ],
  "Latin American": [
    "Mexican",
    "Tex-Mex",
    "Peruvian",
    "Brazilian",
    "Salvadoran",
    "Cuban & Caribbean",
    "Latin fusion"
  ],
  "Middle Eastern & Mediterranean": [
    "Lebanese",
    "Turkish",
    "Persian",
    "Mediterranean (pan-regional)"
  ],
  "Pacific Islander": [
    "Hawaiian",
    "Polynesian",
    "Samoan",
    "Tongan"
  ],
  "American": [
    "American",
    "Southern & Soul",
    "Cajun"
  ],
  "African": [
    "Ethiopian",
    "West African",
    "North African"
  ]
};
export const FOOD_TYPES = ["Pizza", "Burgers", "Sandwiches & Subs", "Chicken & Wings", "BBQ", "Breakfast & Brunch", "Bakery & Cookies", "Desserts & Ice Cream", "Shave Ice", "Coffee & Cafe", "Soda & Drinks", "Smoothies & Juice", "Salads & Bowls", "Tacos & Burritos", "Noodles & Ramen", "Sushi & Poke", "Seafood"];
export const normalizeOrigin = value => value === 'Pan-Asian' ? 'Pan-Asian / Asian fusion' : value ?? null;
export const regionFor = (origin, rows) => rows?.find(row => row.cuisine === normalizeOrigin(origin))?.region ?? Object.keys(REGIONS).find(region => REGIONS[region].includes(normalizeOrigin(origin))) ?? null;
const normalize = value => value.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
/** Each phrase maps to a dimension, never a bag of words from another region. */
export const SYNONYMS = {
  Asian: ['asian', 'asia'], European: ['european', 'europe'],
  'Latin American': ['latin', 'hispanic', 'latin american'],
  'Middle Eastern & Mediterranean': ['middle eastern', 'mediterranean'],
  'Pacific Islander': ['pacific islander'], African: ['african'],
  Hawaiian: ['hawaiian'], Polynesian: ['polynesian', 'hawaiian'],
  Japanese: ['japanese', 'sushi', 'teriyaki', 'hibachi'],
  Chinese: ['chinese'], Korean: ['korean', 'kbbq'], Thai: ['thai'],
  Vietnamese: ['vietnamese', 'pho'], Indian: ['indian', 'curry'],
  Italian: ['italian', 'pasta'], Greek: ['greek', 'gyro', 'gyros'],
  French: ['french', 'crepe', 'crepes'], Mexican: ['mexican'],
  Peruvian: ['peruvian'], Brazilian: ['brazilian'],
  Pizza: ['pizza', 'pizzas'], Burgers: ['burger', 'burgers', 'hamburger', 'hamburgers', 'cheeseburger'],
  'Chicken & Wings': ['chicken', 'wings', 'wing', 'tenders', 'nuggets', 'fried chicken'],
  BBQ: ['bbq', 'barbecue', 'barbeque', 'brisket'],
  'Desserts & Ice Cream': ['dessert', 'desserts', 'ice cream', 'icecream', 'froyo', 'gelato', 'sweets', 'custard', 'frozen yogurt'],
  'Bakery & Cookies': ['bakery', 'cookie', 'cookies', 'donut', 'donuts', 'doughnut', 'doughnuts', 'pastries', 'dessert', 'desserts', 'sweets'],
  'Soda & Drinks': ['boba', 'bubble tea', 'soda', 'sodas', 'drinks', 'lemonade', 'tea'],
  'Smoothies & Juice': ['smoothie', 'smoothies', 'juice', 'juices', 'boba', 'bubble tea'],
  'Coffee & Cafe': ['coffee', 'cafe', 'espresso', 'latte'],
  'Breakfast & Brunch': ['breakfast', 'brunch', 'pancake', 'pancakes', 'waffle', 'waffles'],
  'Tacos & Burritos': ['taco', 'tacos', 'burrito', 'burritos', 'quesadilla', 'quesadillas', 'nachos', 'enchiladas'],
  'Noodles & Ramen': ['noodle', 'noodles', 'ramen'],
  'Sushi & Poke': ['sushi', 'poke'], 'Salads & Bowls': ['salad', 'salads', 'bowls', 'healthy'],
  'Shave Ice': ['shave ice', 'shaved ice', 'snow cone', 'snow cones'],
  'Sandwiches & Subs': ['sandwich', 'sandwiches', 'sub', 'subs', 'hoagie', 'deli'],
  Seafood: ['seafood'],
};
const vocabulary=[...new Set([...Object.keys(REGIONS),...Object.values(REGIONS).flat(),...FOOD_TYPES])].map(name=>({name,normalized:normalize(name),synonyms:SYNONYMS[name]||[]}));
const targetCache=new Map();
export function queryTargets(query) {
  if(!query)return [];
  const q=normalize(query);if(!q)return [];
  if(!targetCache.has(q)){if(targetCache.size>=64)targetCache.delete(targetCache.keys().next().value);targetCache.set(q,vocabulary.filter(v=>v.normalized===q||v.synonyms.includes(q)).map(v=>v.name));}
  return targetCache.get(q);
}
/** American is both a region and a cuisine: region selection intentionally wins. */
export function matchesCuisine(business, value = 'All', secondary = true, rows) {
  if (value === 'All') return true;
  if (value === 'Other') return !business.isFood;
  if (value in REGIONS) return regionFor(business.originPrimary, rows) === value;
  if (FOOD_TYPES.includes(value)) return (business.foodTypes ?? []).includes(value);
  return normalizeOrigin(business.originPrimary) === value ||
    (secondary && normalizeOrigin(business.originSecondary) === value);
}
export function matchesCuisineQuery(business, query, rows) {
  const targets = queryTargets(query);
  return targets.length ? targets.some(value => matchesCuisine(business, value, true, rows)) : null;
}
export function secondaryCuisine(business, selection, query = '') {
  // Each active dimension must match: a primary region/type must not conceal a
  // secondary-only match to the other, specific-cuisine search/filter.
  for (const targets of [selection && selection !== 'All' ? [selection] : [], queryTargets(query)]) {
    if (targets.some(value => matchesCuisine(business, value, false))) continue;
    const secondary = targets.find(value => !(value in REGIONS) && !FOOD_TYPES.includes(value) && normalizeOrigin(business.originSecondary) === value);
    if (secondary) return secondary;
  }
  return null;
}
export function pickerMatches(value, query) {
  return normalize(value).includes(normalize(query)) || (SYNONYMS[value] ?? []).some(word => word.includes(normalize(query)));
}
