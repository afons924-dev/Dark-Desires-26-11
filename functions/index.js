const { onRequest } = require("firebase-functions/v2/https");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions/v2");
const admin = require("firebase-admin");
const axios = require("axios");
const crypto = require("crypto");
const https = require('https');
const querystring = require('querystring');
const renderer = require("./renderer");
const Stripe = require("stripe");

// Initialize Firebase Admin SDK
admin.initializeApp();
const db = admin.firestore();
renderer && renderer.init && renderer.init(db);

// Define allowed origins for CORS
const corsOptions = {
  origin: [
    "https://desire-loja-final.web.app",
    "https://darkdesire.pt",
    "http://localhost:5000",
    "http://127.0.0.1:5000",
  ],
  methods: ["POST", "GET"],
  allowedHeaders: ["Content-Type", "Authorization"],
};

// Initialize Stripe client on-demand within functions
let stripe;

/**
 * Helper: safe parse JSON
 */
function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch (e) {
    return null;
  }
}

/**
 * Creates a Stripe Payment Intent.
 */
exports.createStripePaymentIntent = onCall(
  { region: "europe-west3", secrets: ["STRIPE_SECRET_KEY"] },
  async (request) => {
    if (!stripe) {
      stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    }

    const { userId, cart } = request.data || {};

    // Allow userId to be null (Guest Checkout) but require cart
    if (!cart || !Array.isArray(cart) || cart.length === 0) {
      throw new HttpsError("invalid-argument", "Missing or invalid parameters: cart is required.");
    }

    try {
      let amount = 0;
      // SECURITY: Recalculate price from DB, ignore client-side price
      for (const item of cart) {
        const productRef = db.collection("products").doc(item.id);
        const productDoc = await productRef.get();
        if (productDoc.exists) {
          // TODO: Check if product is in Flash Sale via DB query to apply discount correctly on server side
          amount += productDoc.data().price * item.quantity;
        }
      }
      const amountInCents = Math.round(amount * 100);

      if (amountInCents < 50) {
        throw new HttpsError(
          "failed-precondition",
          `Amount is too small. Minimum charge is €0.50. Amount calculated: €${amount.toFixed(2)}`
        );
      }

      // Metadata for guest checkout
      const metadata = userId ? { userId } : { isGuest: "true" };

      const paymentIntent = await stripe.paymentIntents.create({
        amount: amountInCents,
        currency: "eur",
        payment_method_types: ["card"],
        metadata: metadata,
      });

      const sessionRef = db.collection("stripe_sessions").doc(paymentIntent.id);
      await sessionRef.set({
        userId: userId || null, // Store null if guest
        cart,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      return { clientSecret: paymentIntent.client_secret };
    } catch (error) {
      logger.error("Stripe Payment Intent creation failed:", error);
      if (error instanceof HttpsError) {
        throw error;
      }
      throw new HttpsError("internal", "Failed to create Stripe Payment Intent.");
    }
  }
);

/**
 * Fulfills an order by creating it in Firestore and updating stock.
 */
const fulfillOrder = async (paymentIntent) => {
  const sessionRef = db.collection("stripe_sessions").doc(paymentIntent.id);
  const sessionDoc = await sessionRef.get();

  if (!sessionDoc.exists) {
    logger.error(`Could not find session for payment intent: ${paymentIntent.id}`);
    return;
  }

  const { userId, cart } = sessionDoc.data();
  if (!cart || !Array.isArray(cart) || cart.length === 0) {
    logger.error("Invalid session data from payment intent:", paymentIntent.id);
    return;
  }

  const orderRef = db.collection("orders").doc();

  try {
    await db.runTransaction(async (transaction) => {
      let userProfile = {};
      let userRef = null;

      if (userId) {
          userRef = db.collection("users").doc(userId);
          const userDoc = await transaction.get(userRef);
          if (userDoc.exists) {
             userProfile = userDoc.data();
          }
      }

      const productRefs = cart.map((item) => db.collection("products").doc(item.id));
      const productDocs = await transaction.getAll(...productRefs);
      const fullCartItems = [];
      const productUpdates = [];

      for (let i = 0; i < cart.length; i++) {
        const productDoc = productDocs[i];
        if (!productDoc.exists) throw new Error(`Product with ID ${cart[i].id} not found.`);
        const productData = productDoc.data();
        const cartItem = cart[i];

        if (productData.stock < cartItem.quantity) throw new Error(`Stock insufficient for ${productData.name}.`);

        const newStock = productData.stock - cartItem.quantity;
        const newSoldCount = (productData.sold || 0) + cartItem.quantity;
        productUpdates.push({ ref: productDoc.ref, data: { stock: newStock, sold: newSoldCount } });

        fullCartItems.push({
          ...cartItem,
          name: productData.name,
          price: productData.price, // Store the price AT TIME OF PURCHASE
          image: (productData.images && productData.images[0]) || productData.image || "",
        });
      }

      const total = paymentIntent.amount / 100;
      const pointsToAward = Math.floor(total);

      // Construct proper shipping address from user profile if available
      let shippingAddress = null;
      if (userId && Object.keys(userProfile).length > 0) {
          shippingAddress = {
              ...(userProfile.address || {}),
              firstName: userProfile.firstName,
              lastName: userProfile.lastName,
              email: userProfile.email
          };
      } else {
          // Fallback for guest (from Stripe or Session if implemented)
          shippingAddress = paymentIntent.shipping || null;
      }

      const orderData = {
        userId: userId || null, // Allow null for guest
        items: fullCartItems,
        total: total,
        paymentIntentId: paymentIntent.id,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        shippingAddress: shippingAddress,
        status: "Em processamento",
      };

      transaction.set(orderRef, orderData);
      productUpdates.forEach((update) => transaction.update(update.ref, update.data));

      if (userRef && userProfile) {
          const newPoints = (userProfile.loyaltyPoints || 0) + pointsToAward;
          transaction.update(userRef, { loyaltyPoints: newPoints, cart: [] });
      }
    });

    await sessionRef.delete();
    logger.info(`Successfully fulfilled order for Payment Intent: ${paymentIntent.id}`);
  } catch (error) {
    logger.error(`Error fulfilling order for Payment Intent ${paymentIntent.id}:`, error);
  }
};

/**
 * Handles webhook events from Stripe.
 */
exports.stripeWebhook = onRequest(
  { region: "europe-west3", secrets: ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"] },
  async (req, res) => {
    if (!stripe) {
      stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    }
    const whSec = process.env.STRIPE_WEBHOOK_SECRET;
    if (!whSec) {
      logger.error("Stripe webhook secret is not configured.");
      return res.status(500).send("Webhook secret not configured.");
    }

    try {
      const signature = req.headers["stripe-signature"];
      let event;
      try {
        const raw = req.rawBody || (req.body && Buffer.from(JSON.stringify(req.body)));
        if (!raw) throw new Error("No raw body available for signature verification");
        event = stripe.webhooks.constructEvent(raw, signature, whSec);
      } catch (sigErr) {
        logger.error("Webhook signature verification failed:", sigErr.message);
        return res.status(400).send(`Webhook Error: ${sigErr.message}`);
      }

      switch (event.type) {
        case "payment_intent.succeeded":
          await fulfillOrder(event.data.object);
          break;
        case "payment_intent.payment_failed":
          logger.warn(`Payment failed: ${event.data.object.last_payment_error?.message}`);
          break;
        default:
          logger.log(`Unhandled event type ${event.type}`);
      }
      return res.status(200).send();
    } catch (err) {
      logger.error("Error handling Stripe webhook.", err);
      return res.status(500).send(`Webhook handling error: ${err.message}`);
    }
  }
);


/**
 * Redirects the user to the AliExpress authorization page.
 */
exports.aliexpressAuthRedirect = onRequest(
  { region: "europe-west3", secrets: ["ALIEXPRESS_APP_KEY"], cors: corsOptions },
  async (req, res) => {
    const { uid } = req.query;
    if (!uid) {
      return res.status(400).send("User ID (uid) is a required query parameter.");
    }

    const APP_KEY = process.env.ALIEXPRESS_APP_KEY ? process.env.ALIEXPRESS_APP_KEY.trim() : null;
    if (!APP_KEY) {
      logger.error("ALIEXPRESS_APP_KEY secret is not set.");
      return res.status(500).send("Application is not configured correctly.");
    }

    const REDIRECT_URI = "https://europe-west3-desire-loja-final.cloudfunctions.net/aliexpressAuthCallback";

    const nonce = crypto.randomBytes(16).toString("hex");
    const state = { uid, nonce };

    await db.collection("aliexpress_auth_states").doc(nonce).set({
      uid,
      nonce,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const rawState = Buffer.from(JSON.stringify(state)).toString("base64");
    const encodedState = encodeURIComponent(rawState);
    const encodedRedirectUri = encodeURIComponent(REDIRECT_URI);

    const authorizationUrl =
      "https://api-sg.aliexpress.com/oauth/authorize" +
      `?response_type=code` +
      `&client_id=${APP_KEY}` +
      `&redirect_uri=${encodedRedirectUri}` +
      `&state=${encodedState}` +
      `&view=web`;

    logger.info(`Redirecting to AliExpress for authorization: ${authorizationUrl}`);
    return res.redirect(authorizationUrl);
  }
);



/**
 * Handles the callback from AliExpress after authorization.
 */
exports.aliexpressAuthCallback = onRequest(
  {
    region: "europe-west3",
    secrets: ["ALIEXPRESS_APP_KEY", "ALIEXPRESS_APP_SECRET"],
    cors: corsOptions,
  },
  async (req, res) => {
    const { code, state } = req.query || {};

    if (!code || !state) {
      return res.status(400).send("Error: Missing code or state from AliExpress callback.");
    }

    logger.info("AliExpress callback received", { code, state });

    try {
      let stateStr = state;
      try {
        stateStr = decodeURIComponent(stateStr);
      } catch (e) {
        logger.debug("State already decoded");
      }

      const maybeJson = safeJsonParse(stateStr);
      let decodedState = null;
      if (maybeJson) {
        decodedState = maybeJson;
      } else {
        try {
          decodedState = JSON.parse(Buffer.from(stateStr, "base64").toString("utf8"));
        } catch (e) {
          logger.error("Failed to decode state");
          return res.status(400).send("Invalid state format.");
        }
      }

      if (!decodedState || !decodedState.uid || !decodedState.nonce) {
        throw new Error("Invalid state format.");
      }

      const stateRef = db.collection("aliexpress_auth_states").doc(decodedState.nonce);
      const stateDoc = await stateRef.get();

      if (!stateDoc.exists) {
        logger.error(`CSRF Warning: State document not found for nonce ${decodedState.nonce}.`);
        return res.status(403).send("Error: Invalid state. CSRF detected.");
      }

      const stored = stateDoc.data();
      if (stored.nonce !== decodedState.nonce || stored.uid !== decodedState.uid) {
        logger.error(`CSRF Warning: State mismatch.`);
        return res.status(403).send("Error: Invalid state. CSRF detected.");
      }

      await stateRef.delete();

      const APP_KEY = process.env.ALIEXPRESS_APP_KEY?.trim();
      const APP_SECRET = process.env.ALIEXPRESS_APP_SECRET?.trim();
      if (!APP_KEY || !APP_SECRET) {
        logger.error("ALIEXPRESS secrets are not set.");
        return res.status(500).send("Application is not configured correctly.");
      }

      const timestamp = Date.now().toString();
      const paramsMap = {
        app_key: APP_KEY,
        timestamp: timestamp,
        sign_method: "sha256",
        code: code,
      };

      const apiName = "/auth/token/create";
      const sortedKeys = Object.keys(paramsMap).sort();
      let signString = apiName;
      sortedKeys.forEach((key) => {
        signString += key + paramsMap[key];
      });

      const sign = crypto.createHmac("sha256", APP_SECRET).update(signString).digest("hex").toUpperCase();

      const params = new URLSearchParams({
        ...paramsMap,
        sign: sign,
      });

      const primaryTokenEndpoint = "https://api-sg.aliexpress.com/rest/auth/token/create";

      let tokenResponse;
      try {
        tokenResponse = await axios.post(primaryTokenEndpoint, params.toString(), {
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          timeout: 15000,
        });
      } catch (err) {
        logger.error("Token exchange failed:", err.response ? err.response.data : err.message);
        throw err;
      }

      const data = tokenResponse.data;

      const access_token = data.access_token || data.result?.access_token || data.data?.access_token;
      const refresh_token = data.refresh_token || data.result?.refresh_token || data.data?.refresh_token;
      const expire_time = data.expire_time || data.result?.expire_time || data.data?.expire_time || 0;
      const refresh_token_valid_time = data.refresh_token_valid_time || data.result?.refresh_token_valid_time || data.data?.refresh_token_valid_time || 0;
      const user_id = data.user_id || data.result?.user_id || data.data?.user_id;
      const user_nick = data.user_nick || data.result?.user_nick || data.data?.user_nick;

      if (!access_token) {
        logger.error("Token exchange returned no access token:", data);
        throw new Error("No access token returned from AliExpress.");
      }

      await db.collection("aliexpress_tokens").doc(decodedState.uid).set({
        accessToken: access_token,
        refreshToken: refresh_token,
        accessTokenExpiresAt: Date.now() + (Number(expire_time) || 0) * 1000,
        refreshTokenExpiresAt: Date.now() + (Number(refresh_token_valid_time) || 0) * 1000,
        aliExpressUserId: user_id,
        aliExpressUserNick: user_nick,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      logger.info(`AliExpress tokens stored for user ${decodedState.uid}`);

      return res.status(200).send("<h1>Authentication successful!</h1><p>You can now close this window.</p>");
    } catch (error) {
      logger.error("Error during AliExpress auth callback:", error.response ? error.response.data : error.message);
      return res.status(500).send("An error occurred during authentication.");
    }
  }
);



/**
 * Fetches product data from AliExpress API.
 */
exports.importAliExpressProduct = onCall(
  { region: "europe-west3", secrets: ["ALIEXPRESS_APP_KEY", "ALIEXPRESS_APP_SECRET"] },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "The function must be called while authenticated.");

    const userDoc = await db.collection("users").doc(request.auth.uid).get();
    if (!userDoc.exists || !userDoc.data().isAdmin) throw new HttpsError("permission-denied", "You must be an admin.");

    const { productUrl } = request.data || {};
    if (!productUrl) throw new HttpsError("invalid-argument", 'Missing "productUrl" argument.');

    let productId;
    try {
      productId = new URL(productUrl).pathname.split("/")[2].replace(".html", "");
    } catch (error) {
      throw new HttpsError("invalid-argument", "Invalid AliExpress product URL.");
    }

    const tokenRef = db.collection("aliexpress_tokens").doc(request.auth.uid);
    const tokenDoc = await tokenRef.get();
    if (!tokenDoc.exists) throw new HttpsError("failed-precondition", "AliExpress account not connected.");

    let { accessToken, refreshToken, accessTokenExpiresAt } = tokenDoc.data();

    const APP_KEY = process.env.ALIEXPRESS_APP_KEY ? process.env.ALIEXPRESS_APP_KEY.trim() : null;
    const APP_SECRET = process.env.ALIEXPRESS_APP_SECRET ? process.env.ALIEXPRESS_APP_SECRET.trim() : null;
    if (!APP_KEY || !APP_SECRET) throw new HttpsError("internal", "API secrets are not configured.");

    if (!accessToken || accessToken === '') {
      logger.error("Access token is missing from Firestore");
      throw new HttpsError("failed-precondition", "Access token is missing. Please reconnect your AliExpress account.");
    }

    // Refresh token if needed
    if (!accessTokenExpiresAt || Date.now() >= accessTokenExpiresAt) {
      logger.info("Access token expired, refreshing...");
      try {
        const params = new URLSearchParams({
          client_id: APP_KEY,
          client_secret: APP_SECRET,
          refresh_token: refreshToken,
          grant_type: "refresh_token",
        });

        const response = await axios.post("https://api-sg.aliexpress.com/rest/auth/token/refresh", params.toString(), {
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
        });

        const rdata = response.data;
        const newAccess = rdata.access_token || rdata.result?.access_token || rdata.data?.access_token;
        if (newAccess) {
          accessToken = newAccess;
          await tokenRef.update({
            accessToken: accessToken,
            refreshToken: rdata.refresh_token || refreshToken,
            accessTokenExpiresAt: Date.now() + ((rdata.expire_time || rdata.result?.expire_time || 0) * 1000),
          });
          logger.info("Successfully refreshed access token.");
        } else {
          logger.error("Failed to refresh token:", rdata);
          throw new Error("Failed to refresh token");
        }
      } catch (error) {
        logger.error("Error refreshing AliExpress access token:", error.response ? error.response.data : error.message);
        throw new HttpsError("unknown", "Could not refresh the AliExpress session.");
      }
    }


    try {
      const timestamp = Date.now().toString();
      const apiMethodName = "aliexpress.ds.product.get";

      const paramsToSign = {
        access_token: accessToken,
        app_key: APP_KEY,
        format: "json",
        method: apiMethodName,
        product_id: productId,
        ship_to_country: "PT",
        sign_method: "sha256",
        target_currency: "EUR",
        target_language: "en",
        timestamp: timestamp,
        v: "2.0",
      };

      const sortedKeys = Object.keys(paramsToSign).sort();
      let signString = "";
      sortedKeys.forEach((key) => {
        signString += key + paramsToSign[key];
      });

      const sign = crypto.createHmac("sha256", APP_SECRET).update(signString).digest("hex").toUpperCase();

      const finalParams = {
        ...paramsToSign,
        sign: sign,
      };

      const postData = querystring.stringify(finalParams);

      logger.info("Making request with correct params:", { ...finalParams, access_token: "***" });

      const response = await axios.post("https://api-sg.aliexpress.com/sync", postData, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      });

      const responseData = response.data;

      logger.info("AliExpress API Response:", JSON.stringify(responseData));

      const result = responseData.aliexpress_ds_product_get_response?.result || responseData.result || responseData.data?.result;

      if (!result) {
        logger.error("Error fetching product from AliExpress (Full Response):", JSON.stringify(responseData));
        throw new HttpsError("not-found", "Could not retrieve product details from AliExpress.");
      }

      // Check if product already exists
      const existingProductQuery = await db.collection('products').where('aliexpressProductId', '==', productId).get();
      if (!existingProductQuery.empty) {
        throw new HttpsError("already-exists", "This product has already been imported.");
      }

      const baseInfo = result.ae_item_base_info_dto || {};
      const skuInfo = result.ae_item_sku_info_dtos?.ae_item_sku_info_d_t_o || [];
      const multimediaInfo = result.ae_multimedia_info_dto || {};

      const totalStock = skuInfo.reduce((acc, sku) => acc + (sku.sku_available_stock || 0), 0);
      const firstSku = skuInfo.length > 0 ? skuInfo[0] : {};

      const newProduct = {
        name: baseInfo.subject || "No name",
        description: baseInfo.detail || "No description",
        price: parseFloat(firstSku.offer_sale_price) || 0,
        stock: totalStock,
        images: multimediaInfo.image_urls ? multimediaInfo.image_urls.split(';') : [],
        category: "Imported", // Default category
        aliexpressProductId: productId,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        sold: 0,
      };

      const docRef = await db.collection('products').add(newProduct);

      logger.info(`Successfully imported product ${productId} as new document ${docRef.id}`);

      return { success: true, productId: docRef.id };
    } catch (error) {
      logger.error("Error fetching AliExpress product:", error);
      if (error instanceof HttpsError) {
        throw error;
      }
      throw new HttpsError("unknown", "An error occurred while fetching product data.");
    }
  }
);

/**
 * Generates an XML Sitemap for SEO.
 * Reads all products and static routes.
 */
exports.sitemap = onRequest({ region: "europe-west3" }, async (req, res) => {
  try {
    const baseUrl = "https://desire.pt"; // Replace with your actual domain
    const staticRoutes = [
      "/",
      "/products",
      "/about",
      "/contact",
      "/faq",
      "/privacy",
      "/terms"
    ];

    let xml = `<?xml version="1.0" encoding="UTF-8"?>
    <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`;

    // Add static routes
    staticRoutes.forEach(route => {
      xml += `
      <url>
        <loc>${baseUrl}/#${route}</loc>
        <changefreq>weekly</changefreq>
        <priority>${route === '/' ? '1.0' : '0.8'}</priority>
      </url>`;
    });

    // Add dynamic products
    const productsSnap = await db.collection("products").get();
    productsSnap.forEach(doc => {
      const p = doc.data();
      // Using hash routing based on your app structure
      xml += `
      <url>
        <loc>${baseUrl}/#/product-detail?id=${doc.id}</loc>
        <lastmod>${p.updatedAt ? new Date(p.updatedAt.toDate()).toISOString() : new Date().toISOString()}</lastmod>
        <changefreq>daily</changefreq>
        <priority>0.9</priority>
      </url>`;
    });

    xml += `</urlset>`;

    res.set("Content-Type", "text/xml");
    res.status(200).send(xml);
  } catch (error) {
    logger.error("Sitemap generation error", error);
    res.status(500).send("Error generating sitemap");
  }
});

/**
 * Server-side rendering function.
 */
exports.ssr = onRequest({ region: "europe-west3" }, renderer.render);
