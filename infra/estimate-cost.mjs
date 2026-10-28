const region = process.argv[2] || 'centralus';
if (!/^[a-z0-9]+$/.test(region)) throw new Error('Use an Azure region name such as eastus.');
const activeHours = Number(process.argv[3] || 0);
if (!Number.isFinite(activeHours) || activeHours < 0 || activeHours > 744) {
  throw new Error('Active replica hours must be between 0 and 744.');
}

const filter = `armRegionName eq '${region}' and priceType eq 'Consumption' and (serviceName eq 'Azure Container Apps' or serviceName eq 'Container Registry' or serviceName eq 'Azure Database for PostgreSQL')`;
let url = `https://prices.azure.com/api/retail/prices?currencyCode=USD&$filter=${encodeURIComponent(filter)}`;
const items = [];
while (url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Azure retail pricing request failed: ${response.status}`);
  const data = await response.json();
  items.push(...data.Items);
  url = data.NextPageLink;
}

function price(productName, skuName, unit, meterName) {
  const candidates = items.filter((item) => item.productName === productName
    && item.skuName === skuName && item.unitOfMeasure === unit
    && !item.tierMinimumUnits
    && (!meterName || item.meterName === meterName));
  const primary = candidates.filter((item) => item.isPrimaryMeterRegion === true);
  const matches = primary.length ? primary : candidates;
  if (matches.length !== 1) {
    throw new Error(`Expected one ${skuName} price for ${region}, found ${matches.length}. Check the Azure pricing calculator.`);
  }
  return matches[0].retailPrice;
}

const database = price('Azure Database for PostgreSQL Flexible Server Burstable BS Series Compute', 'B1MS', '1 Hour') * 730;
const storage = price('Azure Database for PostgreSQL Flex Server Storage', 'Storage', '1 GB/Month') * 32;
const registry = price('Container Registry', 'Basic', '1/Day', 'Basic Registry Unit') * 730 / 24;
const cpuRate = price('Azure Container Apps', 'Standard', '1 Second', 'Standard vCPU Active Usage');
const memoryRate = price('Azure Container Apps', 'Standard', '1 GiB Second', 'Standard Memory Active Usage');
const cpuSeconds = activeHours * 3600 * 0.25;
const memorySeconds = activeHours * 3600 * 0.5;
const compute = cpuSeconds * cpuRate + memorySeconds * memoryRate;
const afterGrant = Math.max(0, cpuSeconds - 180_000) * cpuRate
  + Math.max(0, memorySeconds - 360_000) * memoryRate;
const baseline = database + storage + registry;
console.table({
  'PostgreSQL B1ms (730 h)': { USD: database.toFixed(2) },
  'Database storage (32 GiB)': { USD: storage.toFixed(2) },
  'Basic container registry': { USD: registry.toFixed(2) },
  'Idle baseline estimate': { USD: baseline.toFixed(2) },
  [`ACA compute (${activeHours} active h, before grants)`]: { USD: compute.toFixed(2) },
  'Total before free grants': { USD: (baseline + compute).toFixed(2) },
  'Total if full monthly compute grants remain': { USD: (baseline + afterGrant).toFixed(2) },
});
console.log(`Region: ${region}. Live USD list prices; not a quote or a spending cap.`);
console.log('Excludes private DNS, queue storage/operations, requests, excess backups, registry overage, egress and taxes.');
console.log('Consumption only: no dedicated profiles, planned maintenance or private endpoints. Compute grants are subscription-wide.');
console.log('A calendar month may exceed 730 hours. Verify subscription currency, SKU availability and actual usage.');
if (baseline > 40) {
  console.error('The base estimate already exceeds the US$40 target. Do not provision without revising the budget.');
  process.exitCode = 1;
}
if (baseline + compute > 40) console.warn('This activity estimate exceeds US$40 before free grants and extras.');
