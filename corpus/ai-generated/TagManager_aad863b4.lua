local TagManager = {}
TagManager.__index = TagManager

-- Create a table to store the tag associations
function TagManager.new()
    local self = setmetatable({}, TagManager)
    self.tags = {}
    return self
end

-- Add a tag to an object
-- @param object: Instance - The object to be tagged
-- @param tag: string - The tag to associate with the object
function TagManager:AddTag(object, tag)
    if not self.tags[tag] then
        self.tags[tag] = {}
    end
    if not self.tags[tag][object] then
        self.tags[tag][object] = true
    end
end

-- Remove a tag from an object
-- @param object: Instance - The object from which the tag should be removed
-- @param tag: string - The tag to disassociate from the object
function TagManager:RemoveTag(object, tag)
    if self.tags[tag] and self.tags[tag][object] then
        self.tags[tag][object] = nil
        if next(self.tags[tag]) == nil then
            self.tags[tag] = nil
        end
    end
end

-- Check if an object has a specific tag
-- @param object: Instance - The object to check for the tag
-- @param tag: string - The tag to check for
-- @return boolean - True if the object has the tag, false otherwise
function TagManager:HasTag(object, tag)
    return self.tags[tag] and self.tags[tag][object] or false
end

-- Get all objects with a specific tag
-- @param tag: string - The tag whose objects should be retrieved
-- @return table - List of objects that have the specified tag
function TagManager:GetObjectsWithTag(tag)
    local objects = {}
    if self.tags[tag] then
        for object in pairs(self.tags[tag]) do
            table.insert(objects, object)
        end
    end
    return objects
end

-- Retrieve all tags associated with a specific object
-- @param object: Instance - The object whose tags should be retrieved
-- @return table - List of tags associated with the specified object
function TagManager:GetTagsForObject(object)
    local tags = {}
    for tag, objects in pairs(self.tags) do
        if objects[object] then
            table.insert(tags, tag)
        end
    end
    return tags
end

-- Clear all tags from all objects
function TagManager:ClearAll()
    self.tags = {}
end

return TagManager