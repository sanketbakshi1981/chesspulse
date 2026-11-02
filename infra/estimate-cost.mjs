const region = process.argv[2] || 'centralus';
if (!/^[a-z0-9]+$/.test(region)) throw new Error('Use an Azure region name such as eastus.');
if (process.argv.length > 3) {
  throw new Error('Usage: node infra/estimate-cost.mjs [region]. App Service is billed even when idle.');
}

const filter = `armRegionName eq '${region}' and priceType eq 'Consumption' and (serviceName eq 'Azure App Service' or serviceName eq 'Azure Database for PostgreSQL')`;
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
const app = price('Azure App Service Basic Plan - Linux', 'B1', '1 Hour') * 730;
const baseline = database + storage + app;
console.table({
  'PostgreSQL B1ms (730 h)': { USD: database.toFixed(2) },
  'Database storage (32 GiB)': { USD: storage.toFixed(2) },
  'Linux App Service B1 (730 h)': { USD: app.toFixed(2) },
  'Monthly baseline (idle or active)': { USD: baseline.toFixed(2) },
});
console.log(`Region: ${region}. Live USD list prices; not a quote or a spending cap.`);
console.log('Excludes excess backups, optional monitoring, egress and taxes.');
console.log('No container registry, VNet, private DNS or activity queue. Stopping the web app does not stop plan charges.');
console.log('A calendar month may exceed 730 hours. Verify subscription currency, SKU availability and actual usage.');
if (baseline > 40) {
  console.error('The base estimate already exceeds the US$40 target. Do not provision without revising the budget.');
  process.exitCode = 1;
}
