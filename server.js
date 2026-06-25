const express = require('express');
const cheerio = require('cheerio');
const htmlDocx = require('html-docx-js');
const cors = require('cors');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

app.use(cors({
  exposedHeaders: ['Content-Disposition']
}));
app.use(express.json());
app.use(express.static('public'));

function modifyUrlPercent(url) {
  try {
    const urlObj = new URL(url);
    urlObj.searchParams.set('percent', '100');
    return urlObj.toString();
  } catch {
    if (url.includes('?')) {
      if (url.includes('percent=')) {
        return url.replace(/percent=\d+/, 'percent=100');
      }
      return url + '&percent=100';
    }
    return url + '?percent=100';
  }
}

function extractTextWithLineBreaks(html) {
  if (!html) return '';
  const $ = cheerio.load(`<div>${html}</div>`);
  const textParts = [];
  
  $('div').children().each((i, elem) => {
    const $elem = $(elem);
    const tagName = elem.tagName.toLowerCase();
    
    if (tagName === 'p' || tagName === 'div' || tagName === 'section' || tagName === 'article') {
      const text = $elem.text().trim();
      if (text) {
        textParts.push(text);
      }
    } else if (tagName === 'br') {
      textParts.push('');
    } else {
      const text = $elem.text().trim();
      if (text) {
        textParts.push(text);
      }
    }
  });
  
  if (textParts.length === 0) {
    return $.text().trim();
  }
  
  return textParts.join('\n');
}

app.post('/api/generate-doc', async (req, res) => {
  let browser = null;
  try {
    const { url } = req.body;
    
    if (!url) {
      return res.status(400).json({ error: '请提供URL' });
    }

    const modifiedUrl = modifyUrlPercent(url);
    console.log('修改后的URL:', modifiedUrl);

    const puppeteer = await import('puppeteer');
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
    });

    const page = await browser.newPage();
    
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    
    await page.goto(modifiedUrl, {
      waitUntil: 'networkidle2',
      timeout: 60000
    });

    await page.waitForSelector('.short-story-share-content', { timeout: 30000 });

    let titleText = '';
    try {
      await page.waitForSelector('.short-story-share-title', { timeout: 10000 });
      titleText = await page.evaluate(() => {
        const el = document.querySelector('.short-story-share-title');
        return el ? el.textContent.trim() : '';
      });
    } catch {
      console.log('未找到.short-story-share-title元素，尝试其他方式');
      titleText = await page.evaluate(() => {
        const h1 = document.querySelector('h1');
        if (h1) return h1.textContent.trim();
        const title = document.querySelector('title');
        if (title) return title.textContent.trim();
        return '';
      });
    }

    const html = await page.content();
    
    const $ = cheerio.load(html);
    const contentElement = $('.short-story-share-content');

    if (!contentElement.length) {
      return res.status(404).json({ error: '未找到class="short-story-share-content"的元素' });
    }

    const textContent = extractTextWithLineBreaks(contentElement.html());
    
    if (!textContent) {
      return res.status(404).json({ error: '元素内容为空' });
    }

    let fileName = 'content';
    if (titleText) {
      fileName = titleText.replace(/[\\/:*?"<>|]/g, '_');
      if (fileName.length > 100) {
        fileName = fileName.substring(0, 100);
      }
    } else {
      const titleElement = $('.short-story-share-title');
      if (titleElement.length) {
        fileName = extractTextWithLineBreaks(titleElement.html()).trim().replace(/[\\/:*?"<>|]/g, '_');
        if (fileName.length > 100) {
          fileName = fileName.substring(0, 100);
        }
      }
    }

    const lines = textContent.split('\n');
    const pTags = lines.map(line => `<p>${line.trim()}</p>`).join('');

    const docxContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="UTF-8">
      </head>
      <body>
        ${pTags}
      </body>
      </html>
    `;

    const docxBuffer = htmlDocx.asBlob(docxContent);
    
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    const encodedFileName = encodeURIComponent(`${fileName}.docx`);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodedFileName}`);
    
    docxBuffer.arrayBuffer().then(buffer => {
      res.send(Buffer.from(buffer));
    });

  } catch (error) {
    console.error('生成文档失败:', error.message);
    if (error.name === 'TimeoutError') {
      return res.status(504).json({ error: '请求超时，请重试' });
    }
    res.status(500).json({ error: '生成文档失败，请重试: ' + error.message });
  } finally {
    if (browser) {
      await browser.close();
    }
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(port, () => {
  console.log(`服务器运行在 http://localhost:${port}`);
});