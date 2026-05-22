local MonetizationBridge = {}

-- State to manage player's purchases and currency
local playerMonetizationData = {}

-- Constants for various product IDs, can be loaded from a configuration file for ease of management 
local PRODUCT_IDS = {
    CashPack1 = "cash_pack_1",
    CashPack2 = "cash_pack_2",
    CashPack3 = "cash_pack_3"
}

-- Currency amounts corresponding to the different product IDs
local CURRENCY_VALUES = {
    [PRODUCT_IDS.CashPack1] = 100, -- Player gets 100 currency units
    [PRODUCT_IDS.CashPack2] = 250, -- Player gets 250 currency units
    [PRODUCT_IDS.CashPack3] = 500  -- Player gets 500 currency units
}

-- Function to initialize player monetization data
function MonetizationBridge.initPlayerData(player)
    playerMonetizationData[player.UserId] = {
        currency = 0
    }
end

-- Function to clean up player data when they leave
function MonetizationBridge.cleanupPlayerData(player)
    playerMonetizationData[player.UserId] = nil
end

-- Handle a purchase by the player
function MonetizationBridge.handlePurchase(player, productId)
    local userId = player.UserId
    if playerMonetizationData[userId] then
        if CURRENCY_VALUES[productId] then
            playerMonetizationData[userId].currency = playerMonetizationData[userId].currency + CURRENCY_VALUES[productId]
            return true -- Purchase successful
        else
            warn("Invalid Product ID: " .. productId)
            return false -- Purchase failed
        end
    else
        warn("Player data not found for UserId: " .. userId)
        return false -- Purchase failed
    end
end

-- Get the currency balance for a player
function MonetizationBridge.getCurrencyBalance(player)
    local userId = player.UserId
    if playerMonetizationData[userId] then
        return playerMonetizationData[userId].currency
    else
        warn("Player data not found for UserId: " .. userId)
        return 0 -- Return 0 if data not found
    end
end

-- Function to reset player's currency, optional use-case
function MonetizationBridge.resetPlayerCurrency(player)
    local userId = player.UserId
    if playerMonetizationData[userId] then
        playerMonetizationData[userId].currency = 0
    else
        warn("Player data not found for UserId: " .. userId)
    end
end

return MonetizationBridge