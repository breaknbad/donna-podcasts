#!/usr/bin/env node
// donna-podcast-curator.js — Manages YouTube audio + curated podcast feeds
// Publishes to GitHub Pages via git push
//
// Usage:
//   node curator.js --youtube          Check YouTube channels, download new audio
//   node curator.js --curate           Build curated feed from source podcasts
//   node curator.js --add-source URL   Add a podcast source to curate from
//   node curator.js --add-episode ID   Add specific episode from a source to curated feed
//   node curator.js --publish          Generate feeds and push to GitHub Pages
//   node curator.js --all              Do everything (youtube + curate + publish)

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const BASE_DIR = '/Users/donna/donna-podcasts';
const CONFIG_FILE = path.join(BASE_DIR, 'config.json');
const FEEDS_DIR = path.join(BASE_DIR, 'feeds');
const AUDIO_DIR = path.join(BASE_DIR, 'audio');
const CURATED_EPISODES_FILE = path.join(BASE_DIR, 'curated-episodes.json');

fs.mkdirSync(FEEDS_DIR, { recursive: true });

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function escapeXml(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ── YouTube Audio ──────────────────────────────────────────────────

function fetchYouTubeRSS(channelId) {
  const xml = execSync(`curl -s 'https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}'`, {
    encoding: 'utf-8', timeout: 30000
  });
  const entries = [];
  const re = /<entry>([\s\S]*?)<\/entry>/g;
  let match;
  while ((match = re.exec(xml)) !== null) {
    const entry = match[1];
    const id = entry.match(/<yt:videoId>(.*?)<\/yt:videoId>/)?.[1];
    const title = entry.match(/<title>(.*?)<\/title>/)?.[1];
    const published = entry.match(/<published>(.*?)<\/published>/)?.[1];
    const description = entry.match(/<media:description>([\s\S]*?)<\/media:description>/)?.[1] || '';
    if (id && title) entries.push({ id, title, published, description: description.slice(0, 500) });
  }
  return entries;
}

function downloadAudio(videoId, channelDir) {
  const outFile = path.join(channelDir, `${videoId}.m4a`);
  if (fs.existsSync(outFile)) return outFile;
  console.log(`  Downloading: ${videoId}...`);
  try {
    execSync(
      `/opt/homebrew/bin/yt-dlp -f 'bestaudio[ext=m4a]/bestaudio' --no-playlist -o '${outFile}' 'https://www.youtube.com/watch?v=${videoId}'`,
      { encoding: 'utf-8', timeout: 300000, stdio: 'pipe' }
    );
    return outFile;
  } catch (e) {
    console.error(`  Failed: ${e.message.split('\n')[0]}`);
    return null;
  }
}

function getFileInfo(filePath) {
  const stats = fs.statSync(filePath);
  let duration = 0;
  try {
    const out = execSync(
      `/opt/homebrew/bin/ffprobe -v error -show_entries format=duration -of csv=p=0 '${filePath}'`,
      { encoding: 'utf-8', timeout: 10000 }
    ).trim();
    duration = Math.round(parseFloat(out));
  } catch (e) {}
  return { size: stats.size, duration };
}

async function processYouTube(config) {
  const ytConfig = config.feeds['youtube-audio'];
  let totalNew = 0;

  for (const channel of ytConfig.channels) {
    console.log(`\nChecking YouTube: ${channel.name}`);
    const channelDir = path.join(AUDIO_DIR, channel.id);
    fs.mkdirSync(channelDir, { recursive: true });

    const metaFile = path.join(channelDir, 'episodes.json');
    let episodes = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf-8')) : [];
    const existingIds = new Set(episodes.map(e => e.id));

    const entries = fetchYouTubeRSS(channel.youtube_channel_id);
    const newEntries = entries.filter(e => !existingIds.has(e.id));

    if (newEntries.length === 0) {
      console.log('  No new videos');
      continue;
    }

    console.log(`  ${newEntries.length} new videos`);
    for (const entry of newEntries) {
      console.log(`  Processing: ${entry.title}`);
      if (channel.download_audio) {
        const audioPath = downloadAudio(entry.id, channelDir);
        if (audioPath) {
          const { size, duration } = getFileInfo(audioPath);
          console.log(`  Uploading to GitHub release...`);
          const releaseUrl = uploadReleaseAsset(channel.id, entry.id, audioPath);
          episodes.push({
            id: entry.id,
            title: entry.title,
            published: entry.published,
            description: entry.description,
            downloaded: true,
            releaseUrl,
            size,
            duration,
            channel: channel.id,
            addedAt: new Date().toISOString(),
          });
          totalNew++;
        }
      }
    }

    fs.writeFileSync(metaFile, JSON.stringify(episodes, null, 2));
  }

  return totalNew;
}

function uploadReleaseAsset(channelId, videoId, filePath) {
  const tag = `${channelId}-audio`;
  try {
    // Check if release exists, create if not
    try {
      execSync(`/opt/homebrew/bin/gh release view ${tag} --repo breaknbad/donna-podcasts`, { stdio: 'pipe' });
    } catch {
      execSync(`/opt/homebrew/bin/gh release create ${tag} --title "${channelId} Audio" --notes "Audio files" --repo breaknbad/donna-podcasts`, { stdio: 'pipe' });
    }
    // Upload asset
    const filename = path.basename(filePath);
    execSync(`/opt/homebrew/bin/gh release upload ${tag} '${filePath}' --clobber --repo breaknbad/donna-podcasts`, { stdio: 'pipe', timeout: 300000 });
    return `https://github.com/breaknbad/donna-podcasts/releases/download/${tag}/${filename}`;
  } catch (e) {
    console.error(`  Upload failed: ${e.message.split('\n')[0]}`);
    return null;
  }
}

function getReleaseAssetUrl(channelId, videoId) {
  return `https://github.com/breaknbad/donna-podcasts/releases/download/${channelId}-audio/${videoId}.m4a`;
}

function generateYouTubeFeed(config, baseUrl) {
  const ytConfig = config.feeds['youtube-audio'];
  let allEpisodes = [];

  for (const channel of ytConfig.channels) {
    const metaFile = path.join(AUDIO_DIR, channel.id, 'episodes.json');
    if (!fs.existsSync(metaFile)) continue;
    const episodes = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
    allEpisodes = allEpisodes.concat(episodes.map(e => ({ ...e, channelName: channel.name, image: channel.image })));
  }

  allEpisodes.sort((a, b) => new Date(b.published) - new Date(a.published));

  const items = allEpisodes.filter(e => e.downloaded).map(e => {
    const audioUrl = e.releaseUrl || getReleaseAssetUrl(e.channel, e.id);
    return `    <item>
      <title>${escapeXml(e.title)}</title>
      <description>${escapeXml(e.channelName + ': ' + e.description)}</description>
      <enclosure url="${audioUrl}" length="${e.size}" type="audio/mp4"/>
      <guid isPermaLink="false">yt-${e.id}</guid>
      <pubDate>${new Date(e.published).toUTCString()}</pubDate>
      <itunes:duration>${formatDuration(e.duration)}</itunes:duration>
      <itunes:author>${escapeXml(e.channelName)}</itunes:author>
    </item>`;
  }).join('\n');

  const firstChannel = ytConfig.channels[0];
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>${escapeXml(ytConfig.title)}</title>
    <description>${escapeXml(ytConfig.description)}</description>
    <link>https://github.com/breaknbad/donna-podcasts</link>
    <language>en-us</language>
    <itunes:author>Donna</itunes:author>
    <itunes:image href="${firstChannel?.image || ''}"/>
${items}
  </channel>
</rss>`;
}

// ── Curated Feed ──────────────────────────────────────────────────

function fetchPodcastRSS(url) {
  try {
    const xml = execSync(`curl -sL '${url}'`, { encoding: 'utf-8', timeout: 30000 });
    const episodes = [];

    // Get show info
    const showTitle = xml.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/)?.[1] || 'Unknown Show';
    const showImage = xml.match(/<itunes:image\s+href="(.*?)"/)?.[1] || '';

    const re = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = re.exec(xml)) !== null) {
      const item = match[1];
      const title = item.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/)?.[1] || '';
      const description = (item.match(/<description>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/description>/)?.[1] || '').slice(0, 500);
      const enclosure = item.match(/<enclosure[^>]+url="([^"]+)"[^>]*length="(\d+)"[^>]*type="([^"]+)"/);
      const audioUrl = enclosure?.[1] || item.match(/<enclosure[^>]+url="([^"]+)"/)?.[1] || '';
      const size = enclosure?.[2] || '0';
      const type = enclosure?.[3] || 'audio/mpeg';
      const pubDate = item.match(/<pubDate>(.*?)<\/pubDate>/)?.[1] || '';
      const duration = item.match(/<itunes:duration>(.*?)<\/itunes:duration>/)?.[1] || '';
      const guid = item.match(/<guid[^>]*>(.*?)<\/guid>/)?.[1] || audioUrl;

      if (audioUrl) {
        episodes.push({
          title, description, audioUrl, size: parseInt(size), type,
          pubDate, duration, guid, showTitle, showImage
        });
      }
    }
    return { showTitle, showImage, episodes };
  } catch (e) {
    console.error(`  Failed to fetch ${url}: ${e.message.split('\n')[0]}`);
    return { showTitle: '', showImage: '', episodes: [] };
  }
}

function loadCuratedEpisodes() {
  if (fs.existsSync(CURATED_EPISODES_FILE)) {
    return JSON.parse(fs.readFileSync(CURATED_EPISODES_FILE, 'utf-8'));
  }
  return [];
}

function saveCuratedEpisodes(episodes) {
  fs.writeFileSync(CURATED_EPISODES_FILE, JSON.stringify(episodes, null, 2));
}

function addSource(rssUrl) {
  const config = loadConfig();
  const existing = config.feeds.curated.sources.find(s => s.rss === rssUrl);
  if (existing) {
    console.log(`Already tracking: ${existing.name}`);
    return;
  }

  console.log(`Fetching: ${rssUrl}`);
  const { showTitle } = fetchPodcastRSS(rssUrl);
  config.feeds.curated.sources.push({
    name: showTitle,
    rss: rssUrl,
    addedAt: new Date().toISOString()
  });
  saveConfig(config);
  console.log(`Added source: ${showTitle}`);
}

function addEpisodeById(episodeGuid) {
  const config = loadConfig();
  const curated = loadCuratedEpisodes();

  for (const source of config.feeds.curated.sources) {
    const { episodes } = fetchPodcastRSS(source.rss);
    const ep = episodes.find(e => e.guid === episodeGuid || e.title.toLowerCase().includes(episodeGuid.toLowerCase()));
    if (ep) {
      if (curated.find(c => c.guid === ep.guid)) {
        console.log(`Already in curated feed: ${ep.title}`);
        return;
      }
      curated.push({
        ...ep,
        curatedAt: new Date().toISOString(),
        source: source.name
      });
      saveCuratedEpisodes(curated);
      console.log(`Added to curated feed: ${ep.title} (from ${source.name})`);
      return;
    }
  }
  console.log(`Episode not found: ${episodeGuid}`);
}

function generateCuratedFeed(config) {
  const curated = loadCuratedEpisodes();
  const curConfig = config.feeds.curated;

  curated.sort((a, b) => new Date(b.curatedAt) - new Date(a.curatedAt));

  const items = curated.map(e => {
    return `    <item>
      <title>${escapeXml(e.title)}</title>
      <description>${escapeXml('[' + e.showTitle + '] ' + e.description)}</description>
      <enclosure url="${escapeXml(e.audioUrl)}" length="${e.size}" type="${e.type}"/>
      <guid isPermaLink="false">${escapeXml(e.guid)}</guid>
      <pubDate>${e.pubDate || new Date(e.curatedAt).toUTCString()}</pubDate>
      ${e.duration ? `<itunes:duration>${e.duration}</itunes:duration>` : ''}
      <itunes:author>${escapeXml(e.showTitle)}</itunes:author>
    </item>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>${escapeXml(curConfig.title)}</title>
    <description>${escapeXml(curConfig.description)}</description>
    <link>https://github.com/breaknbad/donna-podcasts</link>
    <language>en-us</language>
    <itunes:author>Donna</itunes:author>
${items}
  </channel>
</rss>`;
}

// ── Publish to GitHub Pages ───────────────────────────────────────

function publish(config) {
  const baseUrl = config.github_pages_base;

  console.log('\nGenerating YouTube Audio feed...');
  const ytFeed = generateYouTubeFeed(config, baseUrl);
  fs.writeFileSync(path.join(FEEDS_DIR, 'youtube-audio.xml'), ytFeed);

  console.log('Generating Curated feed...');
  const curFeed = generateCuratedFeed(config);
  fs.writeFileSync(path.join(FEEDS_DIR, 'curated.xml'), curFeed);

  // Create index page
  fs.writeFileSync(path.join(BASE_DIR, 'index.html'), `<!DOCTYPE html>
<html><head><title>Donna Podcasts</title></head>
<body>
<h1>Donna's Podcast Feeds</h1>
<ul>
<li><a href="feeds/youtube-audio.xml">YouTube Audio</a> (Liam Ottley + more)</li>
<li><a href="feeds/curated.xml">Donna's Picks</a> (curated episodes)</li>
</ul>
</body></html>`);

  console.log('Pushing to GitHub Pages...');
  try {
    execSync('git add -A && git diff --cached --quiet || git commit -m "Update feeds ' + new Date().toISOString().split('T')[0] + '"', {
      cwd: BASE_DIR, encoding: 'utf-8', stdio: 'pipe'
    });
    execSync('git push 2>&1', { cwd: BASE_DIR, encoding: 'utf-8', stdio: 'pipe' });
    console.log('Published!');
  } catch (e) {
    if (e.message.includes('nothing to commit')) {
      console.log('No changes to publish');
    } else {
      console.error('Push failed:', e.message.split('\n')[0]);
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const config = loadConfig();

  if (args.includes('--add-source')) {
    const url = args[args.indexOf('--add-source') + 1];
    addSource(url);
    return;
  }

  if (args.includes('--add-episode')) {
    const id = args[args.indexOf('--add-episode') + 1];
    addEpisodeById(id);
    return;
  }

  if (args.includes('--youtube') || args.includes('--all')) {
    const newCount = await processYouTube(config);
    console.log(`YouTube: ${newCount} new episodes`);
  }

  if (args.includes('--curate') || args.includes('--all')) {
    console.log('\nCurated feed has', loadCuratedEpisodes().length, 'episodes');
    console.log('Sources:', config.feeds.curated.sources.map(s => s.name).join(', ') || 'none yet');
  }

  if (args.includes('--publish') || args.includes('--all')) {
    publish(config);
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
