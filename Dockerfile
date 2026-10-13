FROM node:22-alpine

WORKDIR /app
COPY package.json server.js ./
COPY public ./public

ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080
EXPOSE 8080
USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
