#!/usr/bin/env python3
"""
train-gnn.py — 训练一个 2-layer Graph Convolutional Network (GCN)
并导出为 ONNX 模型供 GnnInferenceEngine 使用。

使用方法：
  python3 scripts/train-gnn.py [--epochs 200] [--output /tmp/gcn-model.onnx]

依赖：
  torch, torch-geometric (pip install torch torch-geometric)

模型结构：
  Input: [batch, num_features]
  GCNConv(16) → ReLU → GCNConv(num_classes) → LogSoftmax

输出：
  - ONNX 模型文件（节点分类）
  - 打印测试样本预测
"""

import argparse
import torch
import torch.nn.functional as F
import numpy as np
import warnings
warnings.filterwarnings('ignore')

# ── 减少依赖：用自制的 Message-Passing 实现（不需要 torch-geometric）───


class SimpleGCN(torch.nn.Module):
    """
    2-layer GCN 用于节点分类。
    因为 GNN 推理引擎只需要前向传播，我们用最简单的矩阵实现：
    H' = σ(A_hat · H · W)
    其中 A_hat = D^{-1/2} · A · D^{-1/2}（归一化邻接矩阵）
    """

    def __init__(self, in_features: int, hidden_dim: int, num_classes: int):
        super().__init__()
        self.conv1 = torch.nn.Linear(in_features, hidden_dim)
        self.conv2 = torch.nn.Linear(hidden_dim, num_classes)

    def forward(self, x: torch.Tensor, adj_norm: torch.Tensor) -> torch.Tensor:
        # GCNConv: X' = σ(A_hat @ X @ W)
        x = adj_norm @ x
        x = self.conv1(x)
        x = F.relu(x)
        x = adj_norm @ x
        x = self.conv2(x)
        return F.log_softmax(x, dim=1)


def create_cora_like_graph(num_nodes: int = 100, num_features: int = 16, num_classes: int = 4, edge_prob: float = 0.05):
    """
    生成一个 Cora-like 的图数据集（合成数据）。
    """
    np.random.seed(42)
    torch.manual_seed(42)

    # 特征矩阵 [num_nodes, num_features]
    x = torch.randn(num_nodes, num_features)

    # 随机邻接矩阵（Erdos-Renyi）
    adj = (torch.rand(num_nodes, num_nodes) < edge_prob).float()
    adj = torch.triu(adj, diagonal=1)
    adj = adj + adj.T  # 对称，无自环
    adj = adj + torch.eye(num_nodes)  # 加自环

    # 归一化：D^{-1/2} @ A @ D^{-1/2}
    d = adj.sum(dim=1)
    d_inv_sqrt = torch.where(d > 0, d.pow(-0.5), torch.zeros_like(d))
    adj_norm = d_inv_sqrt.unsqueeze(1) * adj * d_inv_sqrt.unsqueeze(0)

    # 随机标签
    y = torch.randint(0, num_classes, (num_nodes,))

    # 训练/验证/测试集划分
    perm = torch.randperm(num_nodes)
    train_mask = torch.zeros(num_nodes, dtype=torch.bool)
    val_mask = torch.zeros(num_nodes, dtype=torch.bool)
    test_mask = torch.zeros(num_nodes, dtype=torch.bool)
    train_mask[perm[:int(num_nodes * 0.6)]] = True
    val_mask[perm[int(num_nodes * 0.6):int(num_nodes * 0.8)]] = True
    test_mask[perm[int(num_nodes * 0.8):]] = True

    return x, adj_norm, y, train_mask, val_mask, test_mask


def train_gcn(in_features=16, hidden_dim=16, num_classes=4, epochs=200, lr=0.01):
    """
    训练 GCN 模型。
    """
    x, adj_norm, y, train_mask, val_mask, test_mask = create_cora_like_graph()

    model = SimpleGCN(in_features, hidden_dim, num_classes)
    optimizer = torch.optim.Adam(model.parameters(), lr=lr)

    for epoch in range(epochs):
        model.train()
        optimizer.zero_grad()
        out = model(x, adj_norm)
        loss = F.nll_loss(out[train_mask], y[train_mask])
        loss.backward()
        optimizer.step()

        if (epoch + 1) % 50 == 0 or epoch == 0:
            model.eval()
            with torch.no_grad():
                pred = out.argmax(dim=1)
                train_acc = (pred[train_mask] == y[train_mask]).float().mean().item()
                val_acc = (pred[val_mask] == y[val_mask]).float().mean().item()
            print(f"Epoch {epoch+1:4d}/{epochs}  loss={loss.item():.4f}  "
                  f"train_acc={train_acc:.4f}  val_acc={val_acc:.4f}")

    # 最终测试
    model.eval()
    with torch.no_grad():
        out = model(x, adj_norm)
        pred = out.argmax(dim=1)
        test_acc = (pred[test_mask] == y[test_mask]).float().mean().item()
    print(f"\nTest accuracy: {test_acc:.4f}")

    return model, x, adj_norm


def export_to_onnx(model, in_features, output_path):
    """
    导出 GCN 模型到 ONNX。

    注意：GNN 推理引擎的 predictLink 期望单节点输入 [1, feature_dim]。
    我们导出两个版本：
    1. 完整图推理 (batch, features) → 用于 computeEmbedding
    2. 链接预测变体 (2, features) → 简化版，拼接两个节点特征

    这里我们只导出完整图推理版本。链接预测在 JS 侧通过拼接特征实现。
    """
    model.eval()

    # 动态 batch 维度
    dummy_input = torch.randn(1, in_features)

    torch.onnx.export(
        model,
        dummy_input,
        output_path,
        input_names=['input'],
        output_names=['output'],
        dynamic_axes={
            'input': {0: 'batch_size'},
            'output': {0: 'batch_size'},
        },
        opset_version=17,
        do_constant_folding=True,
    )
    print(f"\nONNX model exported to: {output_path}")


def verify_onnx(output_path, in_features):
    """验证 ONNX 模型可用 onnxruntime 加载和推理。"""
    import onnxruntime as ort

    session = ort.InferenceSession(output_path)
    print(f"ONNX model inputs: {[n.name for n in session.get_inputs()]}")
    print(f"ONNX model outputs: {[n.name for n in session.get_outputs()]}")

    # 推理测试
    test_input = np.random.randn(1, in_features).astype(np.float32)
    result = session.run(None, {'input': test_input})
    print(f"Test inference output shape: {result[0].shape}")
    print(f"Output probabilities: {result[0][0][:5]} ...")
    print(f"Predicted class: {result[0].argmax(axis=1)[0]}")
    return True


def main():
    parser = argparse.ArgumentParser(description='Train GCN and export to ONNX')
    parser.add_argument('--epochs', type=int, default=200, help='Training epochs')
    parser.add_argument('--output', type=str, default='/tmp/gcn-model.onnx',
                        help='Output ONNX model path')
    parser.add_argument('--features', type=int, default=16, help='Input feature dimension')
    parser.add_argument('--hidden', type=int, default=16, help='Hidden layer dimension')
    parser.add_argument('--classes', type=int, default=4, help='Number of classes')
    args = parser.parse_args()

    print(f"=== Training 2-layer GCN ===")
    print(f"Features: {args.features}, Hidden: {args.hidden}, Classes: {args.classes}")
    print(f"Output: {args.output}")

    model, x, adj_norm = train_gcn(
        in_features=args.features,
        hidden_dim=args.hidden,
        num_classes=args.classes,
        epochs=args.epochs,
    )

    export_to_onnx(model, args.features, args.output)
    verify_onnx(args.output, args.features)
    print("\nDone!")


if __name__ == '__main__':
    main()
