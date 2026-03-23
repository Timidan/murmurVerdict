FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --legacy-peer-deps
COPY . .
EXPOSE 3001
CMD ["npx", "tsx", "src/loop/index.ts"]
