FROM node:22-alpine
WORKDIR /app
COPY package.json LICENSE NOTICE ./
COPY bin ./bin
COPY src ./src
COPY config ./config
COPY examples ./examples
USER node
EXPOSE 10101
ENTRYPOINT ["node", "./bin/aocx.mjs"]
CMD ["serve", "--config", "./config/docker.example.json"]
