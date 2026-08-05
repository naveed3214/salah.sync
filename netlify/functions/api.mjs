import serverless from 'serverless-http';

// server.js also runs locally as a normal Express server. Set this flag before
// importing it so the Netlify bundle exports the app without opening a port.
process.env.NETLIFY_FUNCTIONS = 'true';

const { default: app } = await import('../../server.js');

export const handler = serverless(app);
