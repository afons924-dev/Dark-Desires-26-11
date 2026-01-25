const { onRequest } = require("firebase-functions/v2/https");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentCreated, onDocumentUpdated } = require("firebase-functions/v2/firestore");
const { logger } = require("firebase-functions/v2");
const admin = require("firebase-admin");
const axios = require("axios");
const crypto = require("crypto");
const https = require('https');
const querystring = require('querystring');
const renderer = require("./renderer");
const Stripe = require("stripe");
const nodemailer = require("nodemailer");

// Initialize Firebase Admin SDK
admin.initializeApp();
const db = admin.firestore();
renderer && renderer.init && renderer.init(db);

const getTransporter = () => {
  return nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS
    }
  });
};

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

    // LOGGING TO DEBUG INVALID ARGUMENT ERROR
    logger.info("createStripePaymentIntent called");
    logger.info("Request Data Type:", typeof request.data);
    logger.info("Request Data Content:", JSON.stringify(request.data));

    const { userId, cart, discount, loyaltyPoints } = request.data || {};

    // Allow userId to be null (Guest Checkout) but require cart
    if (!cart || !Array.isArray(cart) || cart.length === 0) {
      logger.error("Invalid Cart Data:", cart);
      throw new HttpsError("invalid-argument", "Missing or invalid parameters: cart is required and must be a non-empty array.");
    }

    try {
      let amount = 0;
      let originalTotal = 0;

      // SECURITY: Recalculate price from DB, ignore client-side price
      for (const item of cart) {
        if (!item.id) continue;
        const productRef = db.collection("products").doc(item.id);
        const productDoc = await productRef.get();
        if (productDoc.exists) {
          const pData = productDoc.data();
          let itemPrice = pData.price;

          // Check for Bundle Discount (Basic implementation: trust client structure implies bundle usage, or check DB)
          // Ideally we should check if the item is part of a bundle in the cart, but for now we use base price.
          // TODO: Implement rigorous Bundle validation.

          // Check for active Flash Sale
          // In a real scenario, we'd query the 'flash_sale/current' doc to see if this productId is on sale.
          // For simplicity/performance in this fix, we will calculate base price.

          const lineTotal = itemPrice * item.quantity;
          amount += lineTotal;
          originalTotal += lineTotal;
        }
      }

      // Apply Bundle Discount if applicable (Logic needed: compare total vs bundle price)
      // For now, we calculate discounts based on the provided codes/points validated against rules.

      // 1. Coupon Discount
      let couponDiscountAmount = 0;
      if (discount && discount.percentage) {
        // Hardcoded validation for known codes to match frontend
        const validCodes = ['BEMVINDO10', 'DESCONTO10', 'PRAZER5'];
        if (validCodes.includes(discount.code)) {
             couponDiscountAmount = amount * (discount.percentage / 100);
             logger.info(`Applying coupon ${discount.code}: -${couponDiscountAmount}`);
        }
      }
      amount -= couponDiscountAmount;

      // 2. Loyalty Points Discount
      let loyaltyDiscountAmount = 0;
      if (loyaltyPoints && loyaltyPoints > 0) {
         // 100 points = 1 EUR
         loyaltyDiscountAmount = loyaltyPoints / 100;
         // Verify user actually has these points if userId is present
         if (userId) {
             const userDoc = await db.collection("users").doc(userId).get();
             if (userDoc.exists) {
                 const currentPoints = userDoc.data().loyaltyPoints || 0;
                 if (currentPoints < loyaltyPoints) {
                     logger.warn(`User ${userId} tried to use ${loyaltyPoints} but only has ${currentPoints}`);
                     loyaltyDiscountAmount = 0; // Deny discount
                 }
             }
         }
         logger.info(`Applying loyalty discount: -${loyaltyDiscountAmount}`);
      }
      amount -= loyaltyDiscountAmount;

      // Final Amount Check
      if (amount < 0) amount = 0;
      const amountInCents = Math.round(amount * 100);

      if (amountInCents < 50) {
        throw new HttpsError(
          "failed-precondition",
          `Amount is too small. Minimum charge is €0.50. Amount calculated: €${amount.toFixed(2)}`
        );
      }

      // Metadata for guest checkout
      const metadata = userId ? { userId } : { isGuest: "true" };

      logger.info(`Creating PaymentIntent for ${amountInCents} cents.`);

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
        discount,
        loyaltyPoints,
        totalAmount: amount,
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

  const { userId, cart, discount, loyaltyPoints } = sessionDoc.data();
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
        discountApplied: discount || null,
        loyaltyPointsUsed: loyaltyPoints || 0,
        paymentIntentId: paymentIntent.id,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        shippingAddress: shippingAddress,
        status: "Em processamento",
      };

      transaction.set(orderRef, orderData);
      productUpdates.forEach((update) => transaction.update(update.ref, update.data));

      if (userRef && userProfile) {
          let newPoints = (userProfile.loyaltyPoints || 0) + pointsToAward;
          if (loyaltyPoints) {
              newPoints -= loyaltyPoints; // Deduct used points
          }
          if (newPoints < 0) newPoints = 0;

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

/**
 * Monitors product stock changes. If stock becomes positive, sends notification emails.
 */
exports.onProductStockUpdate = onDocumentUpdated(
    { region: "europe-west3", document: "products/{productId}", secrets: ["EMAIL_USER", "EMAIL_PASS"] },
    async (event) => {
        const before = event.data.before.data();
        const after = event.data.after.data();

        // Check if stock increased from <= 0 to > 0
        if (before.stock <= 0 && after.stock > 0) {
            const productId = event.params.productId;
            const productName = after.name;

            // Query pending notifications
            const notificationsRef = db.collection('notifications');
            const snapshot = await notificationsRef
                .where('productId', '==', productId)
                .where('status', '==', 'pending')
                .get();

            if (snapshot.empty) {
                return;
            }

            const transporter = getTransporter();

            const emailPromises = [];
            const updatePromises = [];

            const baseUrl = process.env.BASE_URL || 'https://desire.pt';

            snapshot.forEach(doc => {
                const notification = doc.data();
                const email = notification.email;

                const mailOptions = {
                    from: process.env.EMAIL_USER,
                    to: email,
                    subject: 'O produto chegou! - Desire',
                    html: `<p>Olá,</p><p>O produto <strong>${productName}</strong> que você estava esperando já está disponível!</p><p><a href="${baseUrl}/#/product-detail?id=${productId}">Clique aqui para comprar agora</a></p>`
                };

                emailPromises.push(transporter.sendMail(mailOptions));
                updatePromises.push(doc.ref.update({ status: 'sent', sentAt: admin.firestore.FieldValue.serverTimestamp() }));
            });

            await Promise.all([...emailPromises, ...updatePromises]);
            logger.info(`Sent back-in-stock notifications for product ${productId} to ${snapshot.size} users.`);
        }
    }
);

/**
 * Sends a welcome email to the user and a notification to the admin when a new newsletter subscription is created.
 */
exports.onNewsletterSubscription = onDocumentCreated(
    { region: "europe-west3", document: "newsletter_subscriptions/{subscriptionId}", secrets: ["EMAIL_USER", "EMAIL_PASS"] },
    async (event) => {
        const data = event.data.data();
        const email = data.email;

        if (!email) {
            logger.warn(`No email found for subscription ${event.params.subscriptionId}, skipping notification.`);
            return;
        }

        const transporter = getTransporter();
        const adminEmail = process.env.ADMIN_EMAIL || 'darkdesire389@gmail.com';

        const welcomeMailOptions = {
            from: process.env.EMAIL_USER,
            to: email,
            subject: 'Bem-vindo à Desire!',
            html: `<p>Obrigado por subscrever a nossa newsletter!</p><p>Fique atento às nossas novidades e ofertas exclusivas.</p>`
        };

        const adminMailOptions = {
            from: process.env.EMAIL_USER,
            to: adminEmail,
            subject: 'Nova Subscrição na Newsletter',
            html: `<p>Um novo utilizador subscreveu a newsletter:</p><p><strong>Email:</strong> ${email}</p>`
        };

        await Promise.all([
            transporter.sendMail(welcomeMailOptions),
            transporter.sendMail(adminMailOptions)
        ]);

        logger.info(`Sent newsletter welcome and admin notification for ${email}`);
    }
);

/**
 * Sends an email to the admin when a new contact message is created.
 */
exports.onContactMessageCreated = onDocumentCreated(
    { region: "europe-west3", document: "contact_messages/{messageId}", secrets: ["EMAIL_USER", "EMAIL_PASS"] },
    async (event) => {
        const data = event.data.data();

        const transporter = getTransporter();
        const adminEmail = process.env.ADMIN_EMAIL || 'darkdesire389@gmail.com';

        const mailOptions = {
            from: process.env.EMAIL_USER,
            to: adminEmail,
            subject: `Nova mensagem de contacto: ${data.name}`,
            html: `<p><strong>Nome:</strong> ${data.name}</p><p><strong>Email:</strong> ${data.email}</p><p><strong>Mensagem:</strong><br>${data.message}</p>`
        };

        await transporter.sendMail(mailOptions);
        logger.info(`Sent contact message notification for message ${event.params.messageId}`);
    }
);

/**
 * Sends an email to the customer when their order status is updated.
 */
exports.onOrderStatusUpdate = onDocumentUpdated(
    { region: "europe-west3", document: "orders/{orderId}", secrets: ["EMAIL_USER", "EMAIL_PASS"] },
    async (event) => {
        const before = event.data.before.data();
        const after = event.data.after.data();

        if (before.status !== after.status) {
            const email = after.shippingAddress?.email;
            if (!email) {
                logger.warn(`No email found for order ${event.params.orderId}, skipping notification.`);
                return;
            }

            const transporter = getTransporter();

            const mailOptions = {
                from: process.env.EMAIL_USER,
                to: email,
                subject: `Atualização da Encomenda #${event.params.orderId}`,
                html: `<p>Olá ${after.shippingAddress.firstName},</p><p>O estado da sua encomenda #${event.params.orderId} mudou para: <strong>${after.status}</strong>.</p>`
            };

            await transporter.sendMail(mailOptions);
            logger.info(`Sent order status update email for order ${event.params.orderId} to ${email}`);
        }
    }
);
