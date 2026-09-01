FROM node:20

WORKDIR /usr/src/app

COPY package.json ./
COPY yarn.lock ./

RUN yarn --frozen-lockfile

# Bundle app source
COPY . .

RUN yarn build

EXPOSE 3002

CMD ["node", "./built/server.js"]
