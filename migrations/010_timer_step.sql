-- Routine (pomodoro) step index on the timer row: the exactly-once expiry
-- UPDATE advances it in the same statement. Plain timers count harmlessly;
-- start zeroes it.
ALTER TABLE timers ADD COLUMN step INTEGER NOT NULL DEFAULT 0;
