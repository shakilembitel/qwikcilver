import { json } from "@shopify/remix-oxygen";
import dotenv from "dotenv";
dotenv.config();

export async function loader() {
  console.log("SHOPIFY_API_SECRET", process.env.SHOPIFY_API_SECRET);
  console.log("SHOPIFY_APP_URL", process.env.SHOPIFY_APP_URL);
  console.log("SHOPIFY_API_VERSION", process.env.SHOPIFY_API_VERSION);
}
export async function action({ request, context }) {
  const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET;
  const SHOPIFY_APP_URL = process.env.SHOPIFY_APP_URL;
  const SHOPIFY_API_VERSION = process.env.SHOPIFY_API_VERSION;

  console.log("SHOPIFY_API_SECRET", SHOPIFY_API_SECRET);
  console.log("SHOPIFY_APP_URL", SHOPIFY_APP_URL);
  console.log("SHOPIFY_API_VERSION", SHOPIFY_API_VERSION);

  if (!SHOPIFY_APP_URL || !SHOPIFY_API_SECRET || !SHOPIFY_API_VERSION) {
    console.error("Missing required environment variables");
    return json({ error: "Server configuration error" }, { status: 500 });
  }

  if (request.method !== "POST") {
    return json({ error: "Method not allowed" }, { status: 405 });
  }

  let actionType, actionData;
  const contentType = request.headers.get("Content-Type");
  if (contentType && contentType.includes("application/json")) {
    const body = await request.json();
    actionType = body.action;
    actionData = body.data;
  } else {
    const formData = await request.formData();
    actionType = formData.get("action");
    actionData = JSON.parse(formData.get("data"));
  }

  if (!actionType || !actionData) {
    return json({ error: "Missing required data" }, { status: 400 });
  }

  try {
    switch (actionType) {
      case "CREATE":
        return await handleCreateAction(
          actionData,
          SHOPIFY_APP_URL,
          SHOPIFY_API_SECRET,
          SHOPIFY_API_VERSION,
        );
      case "CHECKUSAGE":
        return await handleCheckUsageAction(
          actionData,
          SHOPIFY_APP_URL,
          SHOPIFY_API_SECRET,
          SHOPIFY_API_VERSION,
        );
      case "DELETECODE":
        return await handleDeleteCodeAction(
          actionData,
          SHOPIFY_APP_URL,
          SHOPIFY_API_SECRET,
          SHOPIFY_API_VERSION,
        );
      case "GETALLCODE":
        return await handleGetAllCodeAction(
          actionData,
          SHOPIFY_APP_URL,
          SHOPIFY_API_SECRET,
          SHOPIFY_API_VERSION,
        );
      case "CANCELREDEEM":
        return await handleCancelRedeemAction(actionData);
      default:
        return json({ error: "Invalid action type" }, { status: 400 });
    }
  } catch (error) {
    console.error(`Error in ${actionType} action:`, error);
    return json({ error: error.message }, { status: 500 });
  }
}

async function handleCreateAction(
  actionData,
  SHOPIFY_APP_URL,
  SHOPIFY_API_SECRET,
  SHOPIFY_API_VERSION,
) {
  const { redeemData, customerId } = actionData;

  const amount = redeemData?.TotalAmount;
  if (!amount) return null;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 15 * 60000);

  const priceRulesRequestOptions = {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": SHOPIFY_API_SECRET,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      price_rule: {
        title: "Qwikcilver Gift Card Coupon",
        value_type: "fixed_amount",
        value: -amount,
        customer_selection: "all",
        target_type: "line_item",
        target_selection: "all",
        once_per_customer: true,
        allocation_method: "across",
        starts_at: now.toISOString(),
        ends_at: expiresAt.toISOString(),
        usage_limit: 1,
      },
    }),
  };

  const priceRulesUrl = `${SHOPIFY_APP_URL}/admin/api/${SHOPIFY_API_VERSION}/price_rules.json`;
  console.log("priceRulesUrl", priceRulesUrl);
  const priceRulesResponse = await fetch(
    priceRulesUrl,
    priceRulesRequestOptions,
  );

  if (!priceRulesResponse.ok) {
    const errorText = await priceRulesResponse.text();
    console.error("Error response:", errorText);
    throw new Error(`HTTP error! status: ${priceRulesResponse.status}`);
  }

  const priceRulesResult = await priceRulesResponse.json();
  console.log("🚀  priceRulesResult", priceRulesResult);

  let price_rules_id = priceRulesResult.price_rule.id;

  const { CurrentBatchNumber, TransactionId, Cards, TotalAmount } = redeemData;
  const { ApprovalCode, CardNumber } = Cards[0];

  function getRandomLetter() {
    return String.fromCharCode(65 + Math.floor(Math.random() * 26));
  }

  function createDiscountCode(...parts) {
    return parts.reduce((code, part) => code + getRandomLetter() + part, "");
  }

  const createCode = createDiscountCode(
    customerId,
    CurrentBatchNumber,
    TotalAmount,
    TransactionId,
    CardNumber + ApprovalCode,
  );

  const discountCodesRequestOptions = {
    method: "POST",
    headers: {
      "X-Shopify-Access-Token": SHOPIFY_API_SECRET,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      discount_code: { code: createCode },
    }),
  };

  const url = `${SHOPIFY_APP_URL}/admin/api/${SHOPIFY_API_VERSION}/price_rules/${price_rules_id}/discount_codes.json`;
  console.log("🚀  url", url);
  const discountCodesResponse = await fetch(url, discountCodesRequestOptions);

  const discountCodesResult = await discountCodesResponse.json();
  console.log("🚀  discountCodesResult", discountCodesResult);

  if (discountCodesResult) {
    let discountCode = {
      couponCodeId: discountCodesResult.discount_code.id,
      code: discountCodesResult.discount_code.code,
      price_rules_id,
      created_at: discountCodesResult.discount_code.created_at,
      usage_count:
        discountCodesResult.discount_code.usage_count === 0 ? false : true,
      code_status: false,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
    };
    return json({ success: true, discountCode });
  } else {
    return json({ success: false, discountCodesResult });
  }
}

async function handleCheckUsageAction(
  actionData,
  SHOPIFY_APP_URL,
  SHOPIFY_API_SECRET,
  SHOPIFY_API_VERSION,
) {
  const { priceRuleId, discountCodeId } = actionData;
  const url = `${SHOPIFY_APP_URL}/admin/api/${SHOPIFY_API_VERSION}/price_rules/${priceRuleId}/discount_codes/${discountCodeId}.json`;
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": SHOPIFY_API_SECRET,
      },
    });

    if (!response.ok) {
      throw new Error(
        `Error fetching discount code: ${response.status} - ${response.statusText}`,
      );
    }

    const data = await response.json();
    let usage = data?.discount_code?.usage_count;
    if (usage === 0) {
      return json({ success: true, usage });
    } else if (usage === 1) {
      return json({ success: false, usage });
    } else {
      return null;
    }
  } catch (error) {
    console.error(error.message);
    return null;
  }
}

async function handleDeleteCodeAction(
  actionData,
  SHOPIFY_APP_URL,
  SHOPIFY_API_SECRET,
  SHOPIFY_API_VERSION,
) {
  const { priceRuleId } = actionData;
  const url = `${SHOPIFY_APP_URL}/admin/api/${SHOPIFY_API_VERSION}/price_rules/${priceRuleId}.json`;

  try {
    const response = await fetch(url, {
      method: "DELETE",
      headers: {
        "X-Shopify-Access-Token": SHOPIFY_API_SECRET,
        "Content-Type": "application/json",
      },
    });
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(
        `Failed to delete price rule: ${errorData.errors || response.statusText}`,
      );
    }
    return json({
      success: true,
      message: "Discount code deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting price rule:", error.message);
    return json(
      {
        success: false,
        error:
          error.message || "An error occurred while deleting the discount code",
      },
      { status: 500 },
    );
  }
}

async function handleGetAllCodeAction(
  actionData,
  SHOPIFY_APP_URL,
  SHOPIFY_API_SECRET,
  SHOPIFY_API_VERSION,
) {
  const { customerId } = actionData;

  if (!customerId) {
    return json(
      { error: "Missing required parameter: customerId" },
      { status: 400 },
    );
  }

  const requestOptions = {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": SHOPIFY_API_SECRET,
    },
  };

  try {
    const response = await fetch(
      `${SHOPIFY_APP_URL}/admin/api/${SHOPIFY_API_VERSION}/price_rules.json`,
      requestOptions,
    );
    if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);

    const { price_rules } = await response.json();
    if (!price_rules?.length) {
      console.error("No price rules found");
      return [];
    }

    let totalPriceRule = price_rules.map((item) => item.id);
    const allDiscountCode = await getAllDiscountCodes(totalPriceRule);
    if (allDiscountCode) {
      return json({ success: true, allDiscountCode });
    } else {
      return json({ success: false, allDiscountCode });
    }
  } catch (error) {
    console.error("Fetch error:", error);
    return [];
  }

  async function getAllDiscountCodes(totalPriceRules) {
    if (!totalPriceRules) return [];

    const requestOptions = {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": SHOPIFY_API_SECRET,
      },
    };

    try {
      const allDiscountCodes = await Promise.all(
        totalPriceRules.map(async (ruleId) => {
          try {
            const response = await fetch(
              `${SHOPIFY_APP_URL}/admin/api/${SHOPIFY_API_VERSION}/price_rules/${ruleId}/discount_codes.json`,
              requestOptions,
            );
            if (!response.ok)
              throw new Error(`HTTP error! Status: ${response.status}`);

            const { discount_codes } = await response.json();
            return (
              discount_codes?.map(
                ({ id, code, price_rule_id, created_at, usage_count }) => ({
                  couponCodeId: id,
                  code,
                  priceRuleId: price_rule_id,
                  created_at,
                  usage_count: usage_count === 0 ? false : true,
                }),
              ) || []
            );
          } catch (error) {
            console.error(`Fetch error for price rule ID ${ruleId}:`, error);
            return [];
          }
        }),
      );

      return filterDiscountCode(allDiscountCodes.flat());
    } catch (error) {
      console.error("Error fetching discount codes:", error);
      return [];
    }
  }

  function filterDiscountCode(allDiscountCodes) {
    if (
      !customerId ||
      !Array.isArray(allDiscountCodes) ||
      allDiscountCodes.length === 0
    ) {
      return [];
    }

    return allDiscountCodes
      .filter(
        (item) =>
          item &&
          typeof item === "object" &&
          item.code &&
          item.code.includes(customerId) &&
          item.usage_count === false,
      )
      .map((item) => ({
        success: true,
        discountCode: {
          couponCodeId: item.couponCodeId,
          code: item.code,
          price_rules_id: item.priceRuleId,
          created_at: item.created_at,
          usage_count: item.usage_count,
        },
      }));
  }
}

async function handleCancelRedeemAction(actionData) {
  const POST_Cancel_Redeem =
    "https://ajf2m0r1na8eau2bn0brcou5h2i0-custuatdev.qwikcilver.com/QwikCilver/XnP/api/v3/gc/transactions/cancel";
  const { input, DateAtClient, TransactionId, Authorization } = actionData;

  function splitAndAssign(inputCode) {
    let OriginalBatchNumber = "";
    let OriginalAmount = "";
    let OriginalTransactionId = "";
    let OriginalApprovalCode = "";
    let cardNumber = "";

    // Split the inputCode string by letters
    const parts = inputCode.split(/([A-Za-z])/).filter(Boolean);

    // Assigning values to variables
    OriginalBatchNumber = parts[3]; // The first value after the first letter (Q)
    OriginalAmount = parts[5]; // The second value after the second letter (A)
    OriginalTransactionId = parts[7]; // The third value after the third letter (A)

    // Processing the last value to separate cardNumber and OriginalApprovalCode
    const lastValue = parts[9]; // The fourth value after the fourth letter (A)
    cardNumber = lastValue.substring(0, 16); // First 16 digits
    OriginalApprovalCode = lastValue.substring(16); // Remaining digits

    // Return the values as an object
    return {
      OriginalBatchNumber,
      OriginalAmount,
      OriginalTransactionId,
      cardNumber,
      OriginalApprovalCode,
    };
  }

  let OriginalBatchNumber,
    OriginalAmount,
    OriginalTransactionId,
    OriginalApprovalCode,
    cardNumber;

  if (typeof input === "string") {
    // Input is a discount code
    const result = splitAndAssign(input);
    OriginalBatchNumber = result.OriginalBatchNumber;
    OriginalAmount = result.OriginalAmount;
    OriginalTransactionId = result.OriginalTransactionId;
    OriginalApprovalCode = result.OriginalApprovalCode;
    cardNumber = result.cardNumber;
  } else if (typeof input === "object") {
    // Input is redeemData
    OriginalBatchNumber = input.CurrentBatchNumber;
    OriginalAmount = input.TotalAmount;
    OriginalTransactionId = input.TransactionId;
    OriginalApprovalCode = input.Cards[0]?.ApprovalCode;
    cardNumber = input.Cards[0]?.CardNumber;
  } else {
    throw new Error("Invalid input type");
  }

  if (
    !OriginalBatchNumber ||
    !OriginalAmount ||
    !OriginalTransactionId ||
    !OriginalApprovalCode ||
    !cardNumber
  ) {
    throw new Error("Missing required parameters");
  }

  try {
    const response = await fetch(POST_Cancel_Redeem, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        DateAtClient,
        TransactionId,
        Authorization: `Bearer ${Authorization}`,
      },
      body: JSON.stringify({
        inputType: "1",
        numberOfCards: 1,
        Cards: [
          {
            CardNumber: cardNumber,
            Amount: OriginalAmount,
            OriginalRequest: {
              OriginalBatchNumber,
              OriginalTransactionId,
              OriginalApprovalCode,
              OriginalAmount,
              OriginalInvoiceNumber: `PC-${OriginalTransactionId}`,
            },
            Reason: "Return",
          },
        ],
        TransactionModeID: 0,
        TransactionTypeId: 312,
      }),
    });

    const data = await response.json();
    if (data.ResponseCode === 0) {
      return json({ success: true, data });
    } else {
      return json({ success: false, data });
    }
  } catch (error) {
    console.error("Error cancel_redeem:", error);
    alert(`Error: ${error.message}`);
  }
}
