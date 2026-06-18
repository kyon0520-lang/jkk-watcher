FROM node:20-slim

# Google Chrome stable をインストール（puppeteerのバンドルChromeは使わない）
RUN apt-get update \
    && apt-get install -y wget gnupg ca-certificates fonts-noto-cjk --no-install-recommends \
    && wget -q -O - https://dl-ssl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google.gpg] http://dl.google.com/linux/chrome/deb/ stable main" > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update \
    && apt-get install -y google-chrome-stable --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# puppeteerは自前のChromeをダウンロードせず、上記のChromeを使う
ENV PUPPETEER_SKIP_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

COPY watcher.js runner.js ./

# 永続データ用ディレクトリ（Fly volumeをここにマウント）
ENV DATA_DIR=/data

CMD ["node", "runner.js"]
