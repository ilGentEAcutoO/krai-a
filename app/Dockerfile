FROM node:20-slim
WORKDIR /srv/krai-a
ENV NODE_ENV=production PORT=8080
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY public ./public
# Least privilege: the app only reads its files; TTS cache lives in /tmp.
USER node
EXPOSE 8080
CMD ["node", "src/server.js"]
