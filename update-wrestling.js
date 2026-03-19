const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const FEEDS_DIR = "/Users/donna/donna-podcasts/feeds";
const CONFIG_FILE = "/Users/donna/donna-podcasts/config.json";

const sources = [
  { name: "FRL", rss: "https://feeds.megaphone.fm/FLOSP3475327438" },
  { name: "Bader Show", rss: "https://feeds.megaphone.fm/FLOSP9913687470" }
];

function escapeXml(str) {
  return (str || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

let allItems = [];

for (const source of sources) {
  console.log(`Fetching: ${source.name}...`);
  // Use maxBuffer to handle large feeds, and pipe through head to limit
  const xml = execSync(`curl -sL '${source.rss}'`, {
    encoding: "utf-8",
    timeout: 30000,
    maxBuffer: 50 * 1024 * 1024
  });

  // Only grab first 30 items per source
  const re = /<item>([\s\S]*?)<\/item>/g;
  let match;
  let count = 0;
  while ((match = re.exec(xml)) !== null && count < 30) {
    const item = match[1];
    const title = item.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/)?.[1] || "";
    const pubDate = item.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] || "";
    const enclosure = item.match(/<enclosure[^>]+url="([^"]+)"[^>]*/)?.[1] || "";
    const duration = item.match(/<itunes:duration>(.*?)<\/itunes:duration>/)?.[1] || "";
    const desc = item.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/)?.[1] || "";
    const guid = item.match(/<guid[^>]*>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/guid>/)?.[1] || enclosure;

    if (enclosure) {
      allItems.push({
        title: `[${source.name}] ${title.trim()}`,
        description: desc.slice(0, 500),
        audioUrl: enclosure,
        duration,
        pubDate,
        guid,
        date: new Date(pubDate),
        source: source.name
      });
      count++;
    }
  }
  console.log(`  Got ${count} episodes`);
}

allItems.sort((a, b) => b.date - a.date);

const frlImage = "https://megaphone.imgix.net/podcasts/1a4ea1d2-11d7-11ed-a0b6-47fd995edfb2/image/FRL_thumb.png?ixlib=rails-4.3.1&max-w=1400&max-h=1400&fit=crop&auto=format,compress";

const items = allItems.map(e => `    <item>
      <title>${escapeXml(e.title)}</title>
      <description>${escapeXml(e.description)}</description>
      <enclosure url="${escapeXml(e.audioUrl)}" length="0" type="audio/mpeg"/>
      <guid isPermaLink="false">${escapeXml(e.guid)}</guid>
      <pubDate>${e.pubDate}</pubDate>
      ${e.duration ? `<itunes:duration>${e.duration}</itunes:duration>` : ""}
      <itunes:author>FloWrestling</itunes:author>
    </item>`).join("\n");

const feed = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>FlowRestling</title>
    <description>FlowRestling Radio Live + The Bader Show</description>
    <link>https://www.flowrestling.org</link>
    <language>en-us</language>
    <itunes:author>FloWrestling</itunes:author>
    <itunes:image href="${frlImage}"/>
${items}
  </channel>
</rss>`;

fs.writeFileSync(path.join(FEEDS_DIR, "wrestling.xml"), feed);
console.log(`\nWrestling feed: ${allItems.length} episodes`);

const config = JSON.parse(fs.readFileSync(CONFIG_FILE));
config.feeds.wrestling = {
  title: "FlowRestling",
  description: "FlowRestling Radio Live + The Bader Show",
  sources,
  image: frlImage
};
fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
console.log("Done");
