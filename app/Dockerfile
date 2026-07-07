# Using a lightweight base image
FROM node:24-alpine

# Setting the working directory inside the container
WORKDIR /app

# package manifest file is securely owned by the node
COPY --chown=node:node package.json ./

# Execute installation flags using the optimized omissions parameters
RUN npm install --omit=dev

# Copy the rest of our application code (app.js and the public/ folder)
COPY --chown=node:node . .

#Dropping the Root user and executing all the task as unprivileged user 'node'
USER node

# Expose the port the Node.js application runs on
EXPOSE 3000

# Command to start the application
CMD ["node", "app.js"]