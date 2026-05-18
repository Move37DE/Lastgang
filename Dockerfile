FROM node:20-alpine

WORKDIR /app

# Backend-Dependencies
COPY backend/package.json ./backend/
RUN cd backend && npm install --production

# Quellcode + Frontend + Daten
COPY backend/ ./backend/
COPY pwa/ ./pwa/

ENV NODE_ENV=production
ENV PORT=3002
ENV OUTPUT_DIR=/data/output
ENV UPLOAD_DIR=/data/uploads

# Persistente Verzeichnisse fuer Azure Files-Mount (optional)
RUN mkdir -p /data/output /data/uploads

EXPOSE 3002

WORKDIR /app/backend
CMD ["node", "server.js"]
