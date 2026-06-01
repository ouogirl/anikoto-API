/* eslint-disable */
const axios = require('axios');
const cheerio = require('cheerio');
async function test() {
  const { data } = await axios.get('https://anikototv.to/watch/haibara-s-teenage-new-game-8axzw', {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36' }
  });
  const $ = cheerio.load(data);
  console.log('Main ID:', $('#watch-main').attr('data-id'));
  console.log('Episodes count:', $('#w-episodes a').length);
  console.log('Body:', $('#w-episodes').html()?.substring(0, 200));
}
test().catch(console.error);
