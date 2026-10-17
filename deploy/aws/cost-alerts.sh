#!/usr/bin/env bash
# Cost alerts by email. Safe to run again; it only creates what is missing.
#
#   cost-alerts.sh <email[,email…]> <monthly budget in USD>
#
# The same alerts as KeniClean's account: the budget counts usage before credits and with tax.
# Expected spend for SenIQ is about $27 a month with GST (t4g.medium $16.35, 30 GB disk $2.74,
# fixed IP $3.65, S3 and the rest under $0.20, then 18% GST); the $35 budget is that with the
# same headroom KeniClean has ($15 expected, $20 budget), so the 80% email means a month
# running above the estimate, not an ordinary one.
#
# 1. A monthly budget: emails at 80% and 100% of the limit, and when AWS forecasts the month
#    will end above it. It counts usage BEFORE credits, so it still warns while credits are paying.
# 2. Cost Anomaly Detection: a daily email when any AWS service's spending looks unusual.
set -euo pipefail
EMAILS=$1 LIMIT=${2:-35}
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
NAME=seniq-monthly
# One subscriber entry per address, for the budget and for the anomaly alert.
budget_subs=$(echo "$EMAILS" | tr ',' '\n' | sed '/^$/d' | sed 's/.*/{"SubscriptionType":"EMAIL","Address":"&"}/' | paste -sd, -)
anomaly_subs=$(echo "$EMAILS" | tr ',' '\n' | sed '/^$/d' | sed 's/.*/{"Type":"EMAIL","Address":"&"}/' | paste -sd, -)

if aws budgets describe-budget --account-id "$ACCOUNT" --budget-name $NAME >/dev/null 2>&1; then
  echo "budget '$NAME' already exists"
else
  note() { echo "{\"Notification\":{\"NotificationType\":\"$1\",\"ComparisonOperator\":\"GREATER_THAN\",\"Threshold\":$2,\"ThresholdType\":\"PERCENTAGE\"},\"Subscribers\":[$budget_subs]}"; }
  aws budgets create-budget --account-id "$ACCOUNT" \
    --budget "{\"BudgetName\":\"$NAME\",\"BudgetType\":\"COST\",\"TimeUnit\":\"MONTHLY\",\"BudgetLimit\":{\"Amount\":\"$LIMIT\",\"Unit\":\"USD\"},\"CostTypes\":{\"IncludeCredit\":false,\"IncludeRefund\":false,\"IncludeTax\":true,\"IncludeSubscription\":true,\"UseBlended\":false,\"IncludeUpfront\":true,\"IncludeRecurring\":true,\"IncludeOtherSubscription\":true,\"IncludeSupport\":true,\"IncludeDiscount\":true,\"UseAmortized\":false}}" \
    --notifications-with-subscribers "[$(note ACTUAL 80),$(note ACTUAL 100),$(note FORECASTED 100)]"
  echo "budget '$NAME' created: \$$LIMIT a month, alerts at 80%, 100% and on forecast"
fi

# Unusual-spending alerts. The billing API lives in us-east-1 whatever region the server is in.
ce() { aws ce --region us-east-1 "$@"; }
if ! MONITOR=$(ce get-anomaly-monitors --query "AnomalyMonitors[?MonitorType=='DIMENSIONAL'] | [0].MonitorArn" --output text 2>&1); then
  echo "!! unusual-spending alerts not set up: $MONITOR"; exit 0
fi
if [ "$MONITOR" = "None" ] || [ -z "$MONITOR" ]; then
  MONITOR=$(ce create-anomaly-monitor --anomaly-monitor '{"MonitorName":"seniq-services","MonitorType":"DIMENSIONAL","MonitorDimension":"SERVICE"}' --query MonitorArn --output text)
  echo "anomaly monitor created"
fi
if [ "$(ce get-anomaly-subscriptions --query "length(AnomalySubscriptions[?SubscriptionName=='seniq-unusual-spend'])" --output text)" = "0" ]; then
  ce create-anomaly-subscription --anomaly-subscription "{\"SubscriptionName\":\"seniq-unusual-spend\",\"Frequency\":\"DAILY\",\"MonitorArnList\":[\"$MONITOR\"],\"Subscribers\":[$anomaly_subs],\"ThresholdExpression\":{\"Dimensions\":{\"Key\":\"ANOMALY_TOTAL_IMPACT_ABSOLUTE\",\"MatchOptions\":[\"GREATER_THAN_OR_EQUAL\"],\"Values\":[\"2\"]}}}" >/dev/null
  echo "unusual-spending alert created: daily email when an anomaly adds \$2 or more"
else
  echo "unusual-spending alert already exists"
fi
