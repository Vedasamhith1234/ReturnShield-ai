"""
ReturnShield AI — Synthetic Data Generator
Generates realistic orders, returns, customer chat transcripts, and image
verification metadata, with fraud patterns deliberately embedded so the
downstream ML pipeline has real signal to learn from.

This data is 100% SYNTHETIC. No real customer data is used anywhere.
"""
import json
import random
import uuid
from datetime import datetime, timedelta

from faker import Faker

fake = Faker()
Faker.seed(42)
random.seed(42)

N_CUSTOMERS = 2500
N_RETURNS = 6000

CATEGORIES = ["Electronics", "Phones", "Laptops", "Apparel", "Shoes",
              "Home & Kitchen", "Beauty", "Toys", "Sporting Goods", "Jewelry"]
HIGH_VALUE_CATEGORIES = {"Electronics", "Phones", "Laptops", "Jewelry"}
PAYMENT_TYPES = ["credit_card", "debit_card", "paypal", "gift_card", "buy_now_pay_later"]
WAREHOUSES = ["DFW1", "ATL2", "ORD3", "LAX4", "JFK5", "SEA6"]
RETURN_REASONS = [
    "Item never arrived",
    "Item arrived damaged",
    "Wrong item sent",
    "Changed my mind",
    "Item not as described",
    "Found cheaper elsewhere",
    "Defective / stopped working",
    "Missing parts/accessories",
]

COPY_PASTE_EXCUSES = [
    "the product broke after one use and i want a refund immediately",
    "this item never arrived even though it says delivered",
    "the box was empty when i opened it please refund me now",
]

ABUSIVE_PHRASES = ["this is ridiculous", "i will report you", "give me my money now",
                    "this company is a scam", "i want to speak to a manager immediately"]


def make_customer(customer_id: int, fraud_ring: bool):
    """A fraud_ring customer is seeded with abusive behavioral traits."""
    account_age_days = random.randint(30, 2200) if not fraud_ring else random.randint(10, 120)
    return {
        "customer_id": f"CUST-{customer_id:05d}",
        "name": fake.name(),
        "account_age_days": account_age_days,
        "home_lat": float(fake.latitude()),
        "home_lng": float(fake.longitude()),
        "is_fraud_ring": fraud_ring,
        "prior_fraud_flags": random.randint(1, 4) if fraud_ring else (1 if random.random() < 0.03 else 0),
        "addresses_used": random.randint(3, 7) if fraud_ring else random.randint(1, 2),
        "payment_methods_used": random.randint(2, 4) if fraud_ring else random.randint(1, 2),
    }


def make_order(order_id: int, customer):
    category = random.choice(CATEGORIES)
    base_price = random.uniform(15, 150)
    if category in HIGH_VALUE_CATEGORIES:
        base_price = random.uniform(300, 2200)
    order_date = fake.date_time_between(start_date="-2y", end_date="-3d")
    delivery_days = random.randint(1, 7)
    delivery_date = order_date + timedelta(days=delivery_days)
    return {
        "order_id": f"ORD-{order_id:06d}",
        "customer_id": customer["customer_id"],
        "category": category,
        "purchase_value": round(base_price, 2),
        "payment_type": random.choice(PAYMENT_TYPES),
        "coupon_used": random.random() < 0.25,
        "warehouse": random.choice(WAREHOUSES),
        "order_date": order_date.isoformat(),
        "delivery_date": delivery_date.isoformat(),
        "delivery_time_days": delivery_days,
        "shipping_distance_km": round(random.uniform(5, 4000), 1),
        "tracking_status": "delivered",
    }


def make_chat(is_fraud: bool, reason: str):
    """Simulate a customer support chat transcript."""
    lines = []
    if is_fraud and reason == "Item never arrived" and random.random() < 0.7:
        # contradiction pattern: claims non-arrival despite delivered tracking
        lines.append(f"Customer: {random.choice(COPY_PASTE_EXCUSES)}")
        lines.append("Agent: Our tracking shows this package was delivered on time.")
        lines.append("Customer: I never received it, I want a refund right now.")
    else:
        lines.append(f"Customer: {reason}. I would like to return this item.")
        lines.append("Agent: I'm sorry to hear that. Can you tell me more?")
        lines.append(f"Customer: {fake.sentence(nb_words=12)}")

    if is_fraud and random.random() < 0.4:
        lines.append(f"Customer: {random.choice(ABUSIVE_PHRASES)}")

    used_copy_paste = is_fraud and random.random() < 0.5
    return {
        "transcript": "\n".join(lines),
        "used_copy_paste_excuse": used_copy_paste,
    }


def make_image_meta(is_fraud: bool):
    """Simulate metadata a vision agent would derive from an uploaded photo."""
    if is_fraud:
        return {
            "sku_match": random.random() > 0.5,
            "staged_damage_suspected": random.random() < 0.55,
            "reused_photo_detected": random.random() < 0.35,
            "serial_number_match": random.random() > 0.6,
        }
    return {
        "sku_match": True,
        "staged_damage_suspected": random.random() < 0.03,
        "reused_photo_detected": random.random() < 0.02,
        "serial_number_match": random.random() > 0.05,
    }


def generate():
    customers = []
    fraud_ring_ids = set(random.sample(range(N_CUSTOMERS), int(N_CUSTOMERS * 0.08)))
    for i in range(N_CUSTOMERS):
        customers.append(make_customer(i, i in fraud_ring_ids))

    orders, returns, chats, images = [], [], [], []
    for i in range(N_RETURNS):
        customer = random.choice(customers)
        order = make_order(i, customer)
        orders.append(order)

        is_fraud_ring_customer = customer["is_fraud_ring"]
        # Base fraud probability driven by ring membership + randomness
        fraud_roll = random.random() < (0.65 if is_fraud_ring_customer else 0.045)

        reason = random.choice(RETURN_REASONS)
        if fraud_roll and random.random() < 0.5:
            reason = "Item never arrived"

        return_date = datetime.fromisoformat(order["delivery_date"]) + timedelta(
            days=random.randint(0, 3) if fraud_roll else random.randint(1, 21)
        )

        # location mismatch: return/ship address far from home address for fraud cases
        gps_mismatch_km = round(random.uniform(300, 3000), 1) if (fraud_roll and random.random() < 0.6) else round(random.uniform(0, 40), 1)

        chat = make_chat(fraud_roll, reason)
        image_meta = make_image_meta(fraud_roll)

        returns.append({
            "return_id": f"RET-{i:06d}",
            "order_id": order["order_id"],
            "customer_id": customer["customer_id"],
            "reason": reason,
            "return_date": return_date.isoformat(),
            "days_before_return": (return_date - datetime.fromisoformat(order["delivery_date"])).days,
            "gps_mismatch_km": gps_mismatch_km,
            "account_age_days": customer["account_age_days"],
            "prior_fraud_flags": customer["prior_fraud_flags"],
            "addresses_used": customer["addresses_used"],
            "payment_methods_used": customer["payment_methods_used"],
            "is_fraud": bool(fraud_roll),  # ground truth label (synthetic)
        })
        chats.append({"return_id": f"RET-{i:06d}", **chat})
        images.append({"return_id": f"RET-{i:06d}", **image_meta})

    with open("/home/claude/returnshield/data/customers.json", "w") as f:
        json.dump(customers, f)
    with open("/home/claude/returnshield/data/orders.json", "w") as f:
        json.dump(orders, f)
    with open("/home/claude/returnshield/data/returns.json", "w") as f:
        json.dump(returns, f)
    with open("/home/claude/returnshield/data/chats.json", "w") as f:
        json.dump(chats, f)
    with open("/home/claude/returnshield/data/images.json", "w") as f:
        json.dump(images, f)

    print(f"Generated {len(customers)} customers, {len(orders)} orders, {len(returns)} returns.")
    print(f"Fraud rate: {sum(r['is_fraud'] for r in returns) / len(returns):.2%}")


if __name__ == "__main__":
    generate()
