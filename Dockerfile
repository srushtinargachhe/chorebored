FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
ENV DB_PATH=/data/chores.db PORT=3000
VOLUME /data
EXPOSE 3000
CMD ["node","server.js"]
